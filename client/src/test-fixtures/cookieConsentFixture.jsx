import React from 'react';
import {createRoot} from 'react-dom/client';
import CookieConsent from '../components/CookieConsent.jsx';
import ConsentFrame from '../components/ConsentFrame.jsx';
function Fixture(){
  return <><h1>Consent lifecycle fixture</h1><button onClick={()=>history.pushState({},'','?page=2')}>Navigate</button>
    <form onSubmit={e=>{e.preventDefault();document.getElementById('result').textContent='Submitted';}}>
      <label>Essential form<input name="name" /></label><button>Submit</button><output id="result"/></form>
    <ConsentFrame title="Optional video" src="https://www.youtube.com/embed/fixture"/>
    <CookieConsent/></>;
}
createRoot(document.getElementById('root')).render(<Fixture/>);
