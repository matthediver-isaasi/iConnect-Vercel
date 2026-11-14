import {supabase} from '../_lib/database.js';
import {authorizeAwards} from './index.js';
import {loadRankings} from '../_lib/assessment/rankings.js';
import {reportRows,spreadsheetText} from '../_lib/assessment/report.js';
import {toCsv} from '../reports/_ddReportHelpers.js';
export default async function handler(req,res,dependencies={}){
  res.setHeader('Cache-Control','private, no-store');
  if(req.method!=='GET')return res.status(405).json({error:'Method not allowed'});
  const db=dependencies.supabase||supabase;if(!db)return res.status(503).json({error:'Reporting unavailable'});
  try{
    const auth=await authorizeAwards(req,db,dependencies.getTenantContext,'awards.management.report');
    if(!auth.context)return res.status(auth.status).json({error:auth.error});
    const {roundId}=req.query||{},format=req.query?.format||'json',section=req.query?.section||'summaries';
    if(typeof roundId!=='string'||!/^[0-9a-f-]{36}$/i.test(roundId)||!['json','csv','xlsx','pdf'].includes(format)
      ||!['summaries','matrix','criteria','workload'].includes(section))return res.status(400).json({error:'Choose a round, report section and format'});
    const rankings=await loadRankings(db,auth.context.tenantId,roundId,{includeSubmitted:true});
    const rows=reportRows(rankings);
    if(format==='json')return res.json({round:{id:rankings.round.id,name:rankings.round.name},
      applications:rankings.entries.map(entry=>({id:entry.id,reference:entry.reference||entry.id})),...rows});
    const filename=`awards-${roundId}-${section}.${format}`;
    if(format==='csv'){
      const headers=Object.keys(rows[section][0]||{Application:''});
      const safe=rows[section].map(row=>Object.fromEntries(headers.map(key=>[key,spreadsheetText(row[key])])));
      res.setHeader('Content-Type','text/csv; charset=utf-8');
      res.setHeader('Content-Disposition',`attachment; filename="${filename}"`);
      return res.send('\ufeff'+toCsv(safe,headers.map(key=>({key,label:key}))));
    }
    if(format==='xlsx'){
      const {default:ExcelJS}=await import('exceljs');
      const workbook=new ExcelJS.Workbook();
      for(const [name,records]of Object.entries(rows)){
        const sheet=workbook.addWorksheet(name);
        const headers=Object.keys(records[0]||{Application:''});
        sheet.columns=headers.map(key=>({header:key,key,width:28}));
        for(const record of records)sheet.addRow(Object.fromEntries(headers.map(key=>[key,spreadsheetText(record[key])])));
        sheet.getRow(1).font={bold:true};
        sheet.views=[{state:'frozen',ySplit:1}];
      }
      res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition',`attachment; filename="${filename}"`);
      return res.send(Buffer.from(await workbook.xlsx.writeBuffer()));
    }
    const {PDFDocument,StandardFonts}=await import('pdf-lib');
    const pdf=await PDFDocument.create(),font=await pdf.embedFont(StandardFonts.Helvetica);
    let page,y;
    const line=text=>{
      if(!page||y<45){page=pdf.addPage([595,842]);y=800;}
      try{page.drawText(text,{x:35,y,size:10,font});}
      catch{throw Object.assign(new Error('PDF font cannot represent this text. Use CSV or Excel to preserve all characters.'),{status:400});}
      y-=15;
    };
    const wrap=text=>{
      let current='';
      for(const char of text.replace(/\r\n?/g,'\n').replace(/\t/g,'    ')){
        if(char==='\n'){line(current);current='';continue;}
        let width;try{width=font.widthOfTextAtSize(current+char,10);}catch{throw Object.assign(new Error('Use CSV or Excel to preserve this report’s characters.'),{status:400});}
        if(width>520){line(current);current=char;}else current+=char;
      }
      line(current);
    };
    wrap(`Awards report: ${rankings.round.name} (${section})`);
    wrap('Answers and scores are submitted evidence only; workload exposes status, never drafts. Judge identities are pseudonymised.');
    for(const row of rows[section]){for(const [key,value]of Object.entries(row))wrap(`${key}: ${value??''}`);line('');}
    res.setHeader('Content-Type','application/pdf');res.setHeader('Content-Disposition',`attachment; filename="${filename}"`);
    return res.send(Buffer.from(await pdf.save()));
  }catch(error){
    return res.status(error.status||503).json({error:error.status?error.message:'Complete report could not be generated; no partial export was returned'});
  }
}
