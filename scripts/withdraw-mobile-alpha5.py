"""Withdraw only the mistakenly released alpha.5, retaining its GitHub draft backup."""
import hashlib
import importlib.util
import json
from pathlib import Path

spec=importlib.util.spec_from_file_location('delivery',Path(__file__).with_name('sync-mobile-r2.py'))
delivery=importlib.util.module_from_spec(spec);spec.loader.exec_module(delivery)
core=delivery.core
VERSION='0.1.0-alpha.5'
ASSETS={
 'YuanHeng-0.1.0-alpha.5-android-arm64.apk':(17238481,'f58b419ee8fa4a8c726da1a00fcbdfd773148cd2b3e62a03bac42ef038913660'),
 'YuanHeng-0.1.0-alpha.5-android-arm64.apk.sha256':(107,'519ba7b0b8fdf08fdb204e4d5b586421e6eaf242db56cf54d730b79f20ee119c')}

def withdraw(s3,bucket,release):
 core.require(release.get('draft') is True and release.get('tag_name')=='mobile-v'+VERSION,'Draft backup required')
 assets={a['name']:a for a in release['assets']}
 pending=[]
 for name,(size,digest) in ASSETS.items():
  core.require(assets.get(name,{}).get('digest')=='sha256:'+digest and assets[name]['size']==size,'Backup mismatch')
  key=f'mobile/releases/{VERSION}/{name}'
  try: head=s3.head_object(Bucket=bucket,Key=key)
  except Exception as e:
   if core.response_code(e) in ('404','NoSuchKey','NotFound'):continue
   raise core.DeliveryError('Object inspection failed') from None
  core.require(head['ContentLength']==size,'Unexpected object size')
  body=s3.get_object(Bucket=bucket,Key=key,IfMatch=head['ETag'])['Body']
  try: data=body.read(size+1)
  finally: body.close()
  core.require(len(data)==size and hashlib.sha256(data).hexdigest()==digest,'Unexpected object content')
  pending.append((key,head['ETag']))
 for key,etag in pending:
  s3.delete_object(Bucket=bucket,Key=key,IfMatch=etag)
  try:s3.head_object(Bucket=bucket,Key=key)
  except Exception as e:
   core.require(core.response_code(e) in ('404','NoSuchKey','NotFound'),'Deletion verification failed')
  else:raise core.DeliveryError('Object still exists')
 print('alpha.5 origin objects withdrawn; GitHub draft retained; no other versions touched')

if __name__=='__main__':
 try:
  release=json.loads(core.run(['gh','api',f'repos/{core.REPOSITORY}/releases/tags/mobile-v{VERSION}'],60))
  s3,bucket=core.client_from_environment();withdraw(s3,bucket,release)
 except Exception:
  raise SystemExit('Withdrawal failed; inspect bounded diagnostics; draft retained')
