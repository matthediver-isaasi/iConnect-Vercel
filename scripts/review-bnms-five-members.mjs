// Read-only provider evidence for the five individually requested repairs.
import { writeFile } from 'node:fs/promises';
import { session } from './repair-bnms-invoice-8958.mjs';
const ids = ['1ab1438d-ddee-49b3-a8fe-b51722c2dbbe','de5730b6-ff54-489b-aeb3-9b4c4595e8aa',
  '2fcd2ba5-1beb-4ee0-9470-b87d3dcd8158','f514de89-2d72-4109-86a5-27bb7e71118b','3a7013f3-bafb-4afa-92d6-d7eefc73e21e'];
const tenant = 'ff2df806-b321-4254-b651-3af11fccf1db';
const {db, request} = await session();
try {
  await db.query('BEGIN READ ONLY');
  const members = (await db.query(`select id,first_name,last_name,email,role_id,created_on,status
    from member where tenant_id=$1 and id=any($2::uuid[])`,[tenant,ids])).rows;
  const results = [];
  for (const member of members) {
    const prefs = (await db.query(`select f.name,v.value,v.created_at,v.updated_at from member_preference_value v
      join preference_field f on f.id=v.field_id where f.tenant_id=$1 and v.member_id=$2`,[tenant,member.id])).rows;
    const account = prefs.find(p=>p.name==='ym_web_site_member_id')?.value;
    const where = `EmailAddress==${JSON.stringify(member.email)}${account?` OR AccountNumber==${JSON.stringify(account)}`:''}`;
    const contacts = (await request(`Contacts?${new URLSearchParams({where,includeArchived:'true'})}`)).Contacts;
    const invoices = [];
    for (const contact of contacts) {
      for (let page=1; page<=10; page++) {
        const batch = (await request(`Invoices?${new URLSearchParams({
          where:`Contact.ContactID==Guid("${contact.ContactID}")`,page:String(page)})}`)).Invoices;
        if(!Array.isArray(batch)) throw Error('Incomplete invoice result');
        invoices.push(...batch);
        if(batch.length<100) break;
        if(page===10) throw Error('Pagination incomplete');
      }
    }
    results.push({member,prefs,contacts,invoices});
    console.log(JSON.stringify({member:member.first_name+' '+member.last_name,
      contacts:contacts.map(c=>({id:c.ContactID,name:c.Name,account:c.AccountNumber,email:c.EmailAddress})),
      invoices:invoices.map(i=>({id:i.InvoiceID,number:i.InvoiceNumber,date:i.DateString,status:i.Status,
        total:i.Total,paid:i.AmountPaid,due:i.AmountDue,lines:i.LineItems?.map(l=>l.Description)}))}));
  }
  await writeFile('/tmp/bnms-five-members-evidence.json',JSON.stringify(results,null,2),{flag:'wx',mode:0o600});
  await db.query('ROLLBACK');
} finally {await db.end();}
