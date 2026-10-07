import {test,expect} from '@playwright/test';
import handler from '../api/public/form-alert-view.js';

function documentResponse(){
  const headers={};let body;
  const response={setHeader(k,v){headers[k]=v;},status(){return response;},send(value){body=value;}};
  handler({method:'GET'},response);
  return {status:200,headers,body};
}
test('standalone bearer stays out of URLs and referrers; grouped/repeatable XSS-safe rendering',async({page})=>{
  const token='a'.repeat(43),seen=[];
  await page.route('**/*',async route=>{
    const request=route.request(),url=new URL(request.url());seen.push(request.url());
    expect(url.origin).toBe('https://form-alert-fixture.test');
    if(url.pathname==='/api/public/form-alert-view') return route.fulfill(documentResponse());
    expect(url.pathname).toBe('/api/public/form-alert-response');
    expect(request.method()).toBe('GET');
    expect(request.headers()['x-form-alert-token']).toBe(token);
    expect(request.headers().referer).toBeUndefined();
    expect(request.headers().cookie).toBeUndefined();
    return route.fulfill({json:{form_name:'Original form',submitted_at:'2026-01-01',anonymous:true,
      answers:[{label:'Group',children:[{label:'Child',value:'<img src=x onerror="window.compromised=true">'}]},
        {label:'Repeating',rows:[[{label:'Rating',value:'4'}]]}]}});
  });
  await page.goto(`https://form-alert-fixture.test/api/public/form-alert-view#${token}`);
  await expect(page.getByRole('heading',{name:'Original form'})).toBeVisible();
  await expect(page.getByText('<img src=x onerror="window.compromised=true">',{exact:true})).toBeVisible();
  await expect(page.getByRole('heading',{name:'Row 1'})).toBeVisible();
  await expect(page.locator('img,nav,form,iframe')).toHaveCount(0);
  expect(await page.evaluate(()=>window.compromised)).toBeUndefined();
  expect(page.url()).not.toContain(token);
  expect(seen.every(url=>!url.includes(token))).toBeTruthy();
});
test('no-token and failed capabilities use the same protected state without admin chrome',async({page})=>{
  await page.route('**/*',route=>{
    if(new URL(route.request().url()).pathname==='/api/public/form-alert-view') return route.fulfill(documentResponse());
    return route.fulfill({status:404,json:{error:'Unavailable'}});
  });
  for(const hash of ['',`#${'b'.repeat(43)}`]){
    await page.goto(`https://form-alert-fixture.test/api/public/form-alert-view${hash}`);
    await expect(page.getByRole('status')).toHaveText('This response is unavailable or the link has expired.');
    await expect(page.locator('nav,form')).toHaveCount(0);
  }
});
