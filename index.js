const puppeteer = require('puppeteer');
const express = require('express');
const bodyParser = require('body-parser');

const app = express();
app.use(bodyParser.json());

app.post('/send-emails', async (req, res) => {
  const invoiceUrls = req.body.invoice;

  if (!Array.isArray(invoiceUrls) || invoiceUrls.length === 0) {
    return res.status(400).json({ error: 'No invoice URLs provided' });
  }

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  try {
    const page = await browser.newPage();

    // 🔐 Login
    await page.goto('https://auth.servicefusion.com/auth/login', { waitUntil: 'networkidle2' });
    await page.type('#company', 'pfs21485');
    await page.type('#uid', 'Lui-G');
    await page.type('#pwd', 'Premierlog5335!');
    await page.click('button[type="submit"]');
    await page.waitForNavigation({ waitUntil: 'networkidle2' });

    // 📄 Go to the Unpaid Invoices Page
    const url = invoiceUrls[0];
    await page.goto(url, { waitUntil: 'networkidle2' });

    // 🔍 Extract all required amounts
    const data = await page.evaluate(() => {
      const labels = {
        "filter=all": "Grand Total Due of All Unpaid Invoices",
        "filter=due": "Grand Total Due of All Past Due",
        "filter=91plus": "91 plus days Past Due",
        "filter=61plus": "61-90 days Past Due",
        "filter=31plus": "31-60 days Past Due",
        "filter=30less": "1-30 days Past Due",
        "filter=current": "Grand Total Due of All Current Invoices"
      };

      const result = {};

      document.querySelectorAll('a[href*="/unpaidInvoices?filter="]').forEach((a) => {
        const href = a.getAttribute('href');
        const key = Object.keys(labels).find(k => href.includes(k));
        if (key && a.querySelector('.total-text')) {
          const value = a.querySelector('.total-text').innerText.trim();
          result[labels[key]] = value;
        }
      });

      return result;
    });

    // ✅ Get cookies to reuse for admin subdomain
    const cookies = await page.cookies();

    // ✅ Open new page to access admin.servicefusion.com
    const adminPage = await browser.newPage();
    await adminPage.setCookie(...cookies);
    await adminPage.goto('https://admin.servicefusion.com/jobs', { waitUntil: 'domcontentloaded' });

    // ✅ Wait for the #oj table and Ready to Invoice category to be visible
    await adminPage.waitForSelector('#oj', { timeout: 10000 });
    await adminPage.waitForFunction(() => {
      return Array.from(document.querySelectorAll('#oj a')).some(el =>
        el.textContent.includes('Ready to Invoice')
      );
    }, { timeout: 10000 });

    // ✅ Extract the "Ready to Invoice" count
    const readyToInvoiceCount = await adminPage.evaluate(() => {
      try {
        const rows = Array.from(document.querySelectorAll('#oj tr'));
        for (const row of rows) {
          const link = row.querySelector('a');
          const badge = row.querySelector('.badge');
          if (
            link &&
            badge &&
            link.textContent.includes('Ready to Invoice') &&
            link.id.includes('oj-OdoRyGXOIgZ7PKc_sLQGOq_OhBpoRM9o2DOWMG0r5mk')
          ) {
            return parseInt(badge.textContent.trim());
          }
        }
        return 0;
      } catch (e) {
        return 0;
      }
    });

    await adminPage.close();

    // ➕ Append to result
    data["Number of Pending Jobs in Ready to Invoice Status"] = readyToInvoiceCount;

    await browser.close();
    return res.json({ success: true, data });

  } catch (err) {
    await browser.close();
    return res.status(500).json({
      success: false,
      error: 'Automation failed',
      details: err.message
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running at http://localhost:${PORT}/send-emails`);
});
