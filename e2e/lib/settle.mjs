// Reloading right after a click can abort the request that click started (the save never reaches the server).
// trackWrites(page) counts in-flight API writes; settledReload() waits for them, then reloads, so every
// "it persists after reload" check reads what the server actually stored.
export function trackWrites(page) {
  let pending = 0;
  const isWrite = (r) => r.url().includes('/api/') && r.method() !== 'GET';
  page.on('request', (r) => { if (isWrite(r)) pending++; });
  const done = (r) => { if (isWrite(r)) pending = Math.max(0, pending - 1); };
  page.on('requestfinished', done);
  page.on('requestfailed', done);
  const settled = async () => {
    await page.waitForTimeout(250);                       // let the click's handler start its request
    for (let i = 0; i < 150 && pending > 0; i++) await page.waitForTimeout(100);
  };
  return { settled, settledReload: async () => { await settled(); await page.reload(); } };
}
