const assert = require("node:assert/strict");
const path = require("node:path");
const { chromium } = require("playwright");

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(`file://${path.resolve(__dirname, "../index.html")}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.LabelRecognizer);

  const result = await page.evaluate(() => {
    const lotte = window.LabelRecognizer.parseLabelText(`
      SPECIALS
      LOTTE GHANA MILK
      CHOCOLATE 50G
      50% OFF
      4903333213559
    `);
    const julies = window.LabelRecognizer.parseLabelText(`
      2 . QO: JULIES ECIALS
      Shah, Bll CHEESE 1686
      15% OFF
      9556121003051
    `);
    return { lotte, julies };
  });

  assert.equal(result.lotte.barcode, "4903333213559");
  assert.equal(result.lotte.productName, "LOTTE GHANA MILK CHOCOLATE 50G");
  assert.equal(result.julies.barcode, "9556121003051");
  assert.equal(result.julies.productName, "JULIES SANDWICH CHEESE 168G");

  await browser.close();
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
