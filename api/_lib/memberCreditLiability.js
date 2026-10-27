const fail=message=>{throw Object.assign(new Error(message),{status:422,code:'member_credit_liability_required'});};

// Read-only readiness evidence, never authorization to issue or spend credit.
// The existing voucher clearing setting is deliberately shared: configuring a
// second issuance-only account would leave redemption on a different ledger.
export async function verifyMemberCreditLiability({
  request,providerTenantId,accountCode,currency,
}){
  if(typeof accountCode!=='string'||!accountCode.trim()
    || !/^[A-Za-z0-9._-]{1,50}$/.test(accountCode.trim())
    || !/^[A-Z]{3}$/.test(currency||'')||!providerTenantId){
    fail('Configure a dedicated voucher clearing liability account before issuing membership credit.');
  }
  const code=accountCode.trim();
  const payload=await request(`Accounts?where=${encodeURIComponent(`Code=="${code}"`)}`);
  const accounts=payload?.Accounts;
  if(!Array.isArray(accounts)||accounts.length!==1)fail('The configured credit liability account is missing or ambiguous.');
  const account=accounts[0];
  if(!account.AccountID||account.Code!==code||account.Status!=='ACTIVE'
    ||account.Type!=='CURRENTLIABILITY'||account.EnablePaymentsToAccount!==true
    ||account.SystemAccount || (account.CurrencyCode&&account.CurrencyCode!==currency)){
    fail('Member credit requires an active, payment-enabled current-liability account, not a bank or revenue account.');
  }
  const organisations=(await request('Organisation'))?.Organisations;
  if(!Array.isArray(organisations)||organisations.length!==1
    || organisations[0].BaseCurrency!==currency){
    fail('Membership credit currency must match the verified accounting organisation base currency.');
  }
  return {version:1,provider:'xero',providerTenantId,accountId:account.AccountID,
    accountCode:code,currency,settingKey:'xero_voucher_clearing_account_code',
    kind:'iconnect_member_credit_liability'};
}
