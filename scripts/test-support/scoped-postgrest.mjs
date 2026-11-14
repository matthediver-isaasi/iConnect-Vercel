import {readFileSync} from 'node:fs';
import {basename,dirname,join,resolve} from 'node:path';

// PostgREST is permitted only as a UNIX-socket gateway into an already
// registered disposable PostgreSQL cluster. No network listener or remote URI.
export function scopedPostgrest(command,args,{enabled,hasSocket}){
  if(!enabled||basename(String(command))!=='postgrest'||args.length!==1)return null;
  const config=args[0],root=dirname(resolve(config));
  if(basename(config)!=='postgrest.conf'||!hasSocket(root))return null;
  let text;try{text=readFileSync(config,'utf8');}catch{return null;}
  const values={};
  for(const line of text.trim().split('\n')){
    const match=/^([a-z-]+)\s*=\s*("(?:[^"\\]|\\.)*"|[0-9]+)$/.exec(line.trim());
    if(!match||Object.hasOwn(values,match[1]))return null;
    try{values[match[1]]=JSON.parse(match[2]);}catch{return null;}
  }
  const keys=['db-uri','db-anon-role','db-schemas','jwt-secret','server-unix-socket','server-unix-socket-mode','db-pool'];
  if(Object.keys(values).length!==keys.length||keys.some(key=>!Object.hasOwn(values,key)))return null;
  let uri;try{uri=new URL(values['db-uri']);}catch{return null;}
  if(uri.protocol!=='postgresql:'||uri.hostname||uri.password||uri.username||uri.pathname!=='/postgres'
    ||uri.searchParams.get('host')!==root||!/^[0-9]{1,5}$/.test(uri.searchParams.get('port')||'')
    ||uri.searchParams.get('user')!=='postgres'||[...uri.searchParams.keys()].join(',')!=='host,port,user')return null;
  const socket=join(root,'postgrest.sock');
  if(values['db-anon-role']!=='anon'||values['db-schemas']!=='public'||values['db-pool']!==1
    ||values['server-unix-socket']!==socket||values['server-unix-socket-mode']!=='600'
    ||values['jwt-secret']!=='awards-local-only-not-valid-outside-tests')return null;
  return socket;
}
