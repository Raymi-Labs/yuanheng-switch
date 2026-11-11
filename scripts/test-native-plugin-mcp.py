#!/usr/bin/env python3
"""Opt-in macOS/Linux native MCP fixture: synthetic home, no model request or credentials."""
import subprocess,os,json,select,time,tempfile,pathlib,signal
import argparse
parser=argparse.ArgumentParser()
parser.add_argument('--engine',required=True,help='Installed Codex engine executable')
args=parser.parse_args()
engine=str(pathlib.Path(args.engine).resolve(strict=True))
with tempfile.TemporaryDirectory(prefix='yh-plugin-mcp-',dir=str(pathlib.Path(tempfile.gettempdir()).resolve())) as tmp:
 root=pathlib.Path(tmp);home=root/'home';home.mkdir();market=root/'market';plugin=market/'plugins'/'sample';(plugin/'.codex-plugin').mkdir(parents=True);(market/'.agents/plugins').mkdir(parents=True)
 (plugin/'.codex-plugin/plugin.json').write_text(json.dumps({'name':'sample','version':'1.0.0','mcpServers':'./.mcp.json'}))
 server=plugin/'server.py';server.write_text('''import sys,json
for line in sys.stdin:
 q=json.loads(line);m=q.get('method');i=q.get('id')
 if i is None:continue
 if m=='initialize':r={'protocolVersion':'2024-11-05','capabilities':{'tools':{}},'serverInfo':{'name':'synthetic-readonly','version':'1'}}
 elif m=='tools/list':r={'tools':[{'name':'ping','description':'Return synthetic constant; no file or network access','inputSchema':{'type':'object','properties':{}},'annotations':{'readOnlyHint':True,'destructiveHint':False,'openWorldHint':False}}]}
 elif m=='tools/call':r={'content':[{'type':'text','text':'SYNTHETIC_MCP_OK'}]}
 else:r={}
 print(json.dumps({'jsonrpc':'2.0','id':i,'result':r}),flush=True)
''')
 (plugin/'.mcp.json').write_text(json.dumps({'mcpServers':{'probe':{'command':__import__('sys').executable,'args':[str(server)]}}}))
 cp=market/'.agents/plugins/marketplace.json';cp.write_text(json.dumps({'name':'yh-mcp-test','plugins':[{'name':'sample','source':{'source':'local','path':'./plugins/sample'},'policy':{'installation':'AVAILABLE','authentication':'ON_INSTALL'},'category':'Productivity'}]}))
 (home/'config.toml').write_text('model_provider="synthetic"\n[model_providers.synthetic]\nname="Synthetic"\nbase_url="http://127.0.0.1:9/v1"\nwire_api="responses"\n')
 env={**os.environ,'CODEX_HOME':str(home)}
 for k in ['OPENAI_API_KEY','CODEX_API_KEY','META_API_KEY','ANTHROPIC_API_KEY']:env.pop(k,None)
 p=subprocess.Popen([engine,'-c','features.remote_plugin=false','app-server'],env=env,cwd=tmp,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True,start_new_session=True)
 def call(i,m,params):
  p.stdin.write(json.dumps({'id':i,'method':m,'params':params})+'\n');p.stdin.flush();end=time.time()+20
  while time.time()<end:
   if not select.select([p.stdout],[],[],.2)[0]:continue
   line=p.stdout.readline()
   if not line:raise RuntimeError('engine exited')
   v=json.loads(line)
   if v.get('id')==i and 'method' not in v:
    if 'error' in v:raise RuntimeError(v['error'])
    return v['result']
  raise RuntimeError('timeout '+m)
 try:
  call(1,'initialize',{'clientInfo':{'name':'yh_test','version':'1'},'capabilities':{'experimentalApi':True}});p.stdin.write('{"method":"initialized"}\n');p.stdin.flush()
  call(2,'config/value/write',{'keyPath':'marketplaces.yh-mcp-test','value':{'source_type':'local','source':str(market)},'mergeStrategy':'replace'})
  call(3,'plugin/install',{'pluginName':'sample','marketplacePath':str(cp)})
  started=call(4,'thread/start',{'cwd':str(root),'modelProvider':'synthetic','model':'synthetic-model','approvalPolicy':'never','sandbox':'read-only'})
  tid=started['thread']['id']
  servers=call(5,'mcpServerStatus/list',{'threadId':tid,'detail':'toolsAndAuthOnly'})
  found=[s for s in servers['data'] if any(k.endswith('ping') for k in s.get('tools',{}))]
  assert found,servers
  s=found[0];print('BUNDLED_MCP_DISCOVERED=',s['name'])
  result=call(6,'mcpServer/tool/call',{'threadId':tid,'server':s['name'],'tool':'ping','arguments':{}})
  assert 'SYNTHETIC_MCP_OK' in json.dumps(result),result
  print('SYNTHETIC_TOOL_CALL=passed; MODEL_REQUESTS=0; REAL_CREDENTIALS=none')
 finally:
  try: os.killpg(p.pid,signal.SIGKILL)
  except ProcessLookupError: pass
  p.wait(timeout=5);print('OWNED_ENGINE_EXITED=yes')
