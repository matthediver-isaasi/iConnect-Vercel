import { test, expect } from '@playwright/test';
const offer = { communication_offer: { id: 'purchase', token: 't'.repeat(43) } };
const categories = [{id:'one',name:'News'}, {id:'two',name:'Events'}];
test.beforeEach(async ({ page }) => {
  await page.route('**/api/admin/event-registration-communication**', route =>
    route.fulfill({json:{categories,category_ids:['two']}}));
  await page.goto('/tests/fixtures/event-registration-consent.html');
});
test('unchecked, booker-only, selected-only, one prompt for duplicate successes and refresh', async ({page}) => {
  const writes=[];
  await page.route('**/api/public/event-registration-consent',route=>{
    const body=route.request().postDataJSON();
    if(body.action!=='choices') writes.push(body);
    return route.fulfill({json:body.action==='choices'?{categories}:{completed:true}});
  });
  await page.evaluate(offer=>{void window.showOffer(offer);void window.showOffer(offer);},offer);
  await expect(page.getByRole('dialog')).toHaveCount(1);
  await expect(page.getByRole('dialog').getByRole('checkbox').first()).not.toBeChecked();
  await expect(page.getByRole('button',{name:'Subscribe to selected'})).toBeDisabled();
  await expect(page.getByText('This does not subscribe anyone', {exact:false})).toBeVisible();
  await page.getByRole('dialog').getByText('News',{exact:true}).click();
  await page.getByRole('button',{name:'Subscribe to selected'}).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(writes[0].category_ids).toEqual(['one']);
  await page.evaluate(offer=>window.showOffer(offer),offer);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.reload();
  await page.evaluate(offer=>window.showOffer(offer),offer);
  await expect(page.getByRole('dialog')).toHaveCount(0);
});
test('Skip and Escape change no categories; confirmation remains available',async({page})=>{
  const writes=[];
  await page.route('**/api/public/event-registration-consent',route=>{
    const body=route.request().postDataJSON();if(body.action!=='choices')writes.push(body);
    return route.fulfill({json:body.action==='choices'?{categories}:{completed:true}});
  });
  await page.evaluate(offer=>{void window.showOffer(offer);},offer);
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect.poll(()=>writes.length).toBe(1);
  expect(writes[0].action).toBe('dismiss');
  expect(writes[0].category_ids).toEqual([]);
  await expect(page.getByRole('link',{name:'View confirmation'})).toBeVisible();
});
test('empty or failed discovery never blocks confirmation; save retry only calls consent',async({page})=>{
  let mode='empty';const writes=[];
  await page.route('**/api/public/event-registration-consent',route=>{
    const body=route.request().postDataJSON();
    if(body.action==='choices')return route.fulfill({json:{categories:mode==='empty'?[]:categories}});
    writes.push(body);
    return route.fulfill(mode==='fail'?{status:503,json:{error:'Preferences unavailable'}}:{json:{completed:true}});
  });
  await page.evaluate(offer=>window.showOffer(offer),offer);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  mode='fail';
  await page.evaluate(offer=>{void window.showOffer(offer);},{communication_offer:{...offer.communication_offer,id:'another'}});
  await page.getByRole('dialog').getByText('News',{exact:true}).click();
  await page.getByRole('button',{name:'Subscribe to selected'}).click();
  await expect(page.getByRole('alert')).toContainText('Preferences unavailable');
  mode='ok';
  await page.getByRole('button',{name:'Retry subscription'}).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(writes).toHaveLength(2);
  expect(writes.every(write=>write.action==='subscribe')).toBe(true);
});
test('admin hydration preserves stored selection and identity changes close the offer',async({page})=>{
  await expect(page.getByTestId('selected')).toHaveText('["two"]');
  await page.route('**/api/public/event-registration-consent',route=>route.fulfill({json:{categories}}));
  await page.evaluate(offer=>{void window.showOffer(offer);},offer);
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.evaluate(()=>window.switchIdentity());
  await expect(page.getByRole('dialog')).toHaveCount(0);
});
