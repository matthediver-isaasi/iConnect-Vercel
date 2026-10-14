import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { attendanceFilterCategory, filterRegistrationAttendance } from './eventRegistrationAttendance.mjs';

test('attendance categories preserve unresolved states instead of inferring absence', () => {
  assert.equal(attendanceFilterCategory({attendance_status:'attended'}), 'attended');
  for (const status of ['absent','below_threshold'])
    assert.equal(attendanceFilterCategory({attendance_status:status}), 'not_attended');
  for (const status of ['pending','unmatched','sync_failed','error','mixed',null,undefined])
    assert.equal(attendanceFilterCategory({attendance_status:status,attended:false}), 'unconfirmed');
  assert.equal(attendanceFilterCategory({attendance_status:'mixed',attendance_details:[{status:'attended'},{status:'pending'}]}), 'attended');
  assert.equal(attendanceFilterCategory({attendance_status:'absent',attended:true}), 'not_attended');
});

test('filters individual delegates without mutating groups or leaking unmatched delegates into export', () => {
  const groups=[{id:'group',groupPayment:{totalCost:100},attendees:[
    {id:'yes',attendance_status:'attended'}, {id:'unknown',attendance_status:'pending'},
  ]},{id:'absent',attendees:[{id:'no',attendance_status:'absent'}]}];
  const before=JSON.stringify(groups);
  assert.equal(filterRegistrationAttendance(groups,'all'),groups);
  const result=filterRegistrationAttendance(groups,'attended');
  assert.equal(result.length,1);
  assert.deepEqual(result[0].attendees.map(a=>a.id),['yes']);
  assert.equal(result[0].groupPayment,groups[0].groupPayment);
  assert.deepEqual(filterRegistrationAttendance(groups,'unconfirmed')[0].attendees.map(a=>a.id),['unknown']);
  assert.equal(JSON.stringify(groups),before);
  assert.deepEqual(filterRegistrationAttendance([],'attended'),[]);
});

test('page combines attendance with status, consent and search before pagination and CSV export', () => {
  const source=readFileSync(new URL('../pages/EventRegistrationReport.jsx',import.meta.url),'utf8');
  const memo=source.slice(source.indexOf('  const filteredGroups = useMemo(() => {'),source.indexOf('  const totalAttendees = useMemo'));
  const context={
    bookingGroups:[{eventTitle:'Webinar',groupPayment:{},attendees:[
      {id:'a',attendee_first_name:'Alice',status:'confirmed',third_party_consent:true,attendance_status:'attended'},
      {id:'b',status:'cancelled',third_party_consent:true,attendance_status:'attended'},
      {id:'c',status:'confirmed',third_party_consent:false,attendance_status:'attended'},
      {id:'d',status:'confirmed',third_party_consent:true,attendance_status:'pending'},
    ]}],attendanceFilter:'attended',statusFilter:'active',consentFilter:'consented',searchQuery:'alice',
    sortBy:'name_asc',organizations:{},useMemo:fn=>fn(),filterRegistrationAttendance,eventInvoiceNumber:()=>null,
  };
  const result=vm.runInNewContext(`${memo}\nfilteredGroups`,context);
  assert.equal(result.length,1);assert.equal(result[0].attendees.length,1);assert.equal(result[0].attendees[0].id,'a');
  assert.match(source,/data-testid="select-attendance-filter"/);
  assert.match(source,/setCurrentPage\(1\);\s*\}, \[searchQuery, statusFilter, consentFilter, attendanceFilter\]/);
  assert.match(source,/const handleClearFilters = \(\) => \{\s*setAttendanceFilter\("all"\)/);
  assert.match(source,/const paginatedGroups = filteredGroups\.slice/);
  assert.match(source.slice(source.indexOf('const handleExportCSV')),/for \(const group of filteredGroups\)/);
});
