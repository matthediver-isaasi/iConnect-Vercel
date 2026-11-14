import test from 'node:test';
import assert from 'node:assert/strict';
import {reportRows,spreadsheetText} from './report.js';
test('spreadsheet exports neutralise formula-leading content without changing ordinary text',()=>{
  for(const value of ['=SUM(1,2)',' +CMD','@name','-2'])assert.equal(spreadsheetText(value),`'${value}`);
  assert.equal(spreadsheetText('Original text'),'Original text');
});
test('reports preserve exact score and excluded submitted evidence separately',()=>{
  const rows=reportRows({entries:[{id:'entry',eligibility:'eligible',complete:true,completed:1,
    officialScore:{numerator:'251',denominator:'3'},assessments:[
      {judge:'Judge alias',revision:1,included:false,recused:true,score:{numerator:'90',denominator:'1'},
        criteriaVersionId:'version',answers:{text:{value:'Original answer',comment:'Original comment'}}},
    ]}]});
  assert.equal(rows.summaries[0]['Exact numerator'],'251');
  assert.equal(rows.matrix[0].Included,'No');
  assert.equal(rows.criteria[0].Answer,'Original answer');
});
