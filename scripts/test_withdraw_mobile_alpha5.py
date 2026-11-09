import importlib.util
from pathlib import Path
import io, unittest
spec=importlib.util.spec_from_file_location('withdraw',Path(__file__).with_name('withdraw-mobile-alpha5.py'));w=importlib.util.module_from_spec(spec);spec.loader.exec_module(w)
class Missing(Exception):
 response={'Error':{'Code':'404'}}
class Store:
 def __init__(self):self.deleted=[]
 def head_object(self,**kw):raise Missing()
 def delete_object(self,**kw):self.deleted.append(kw)
class Tests(unittest.TestCase):
 def release(self):return {'draft':True,'tag_name':'mobile-v'+w.VERSION,'assets':[{'name':n,'size':s,'digest':'sha256:'+h}for n,(s,h)in w.ASSETS.items()]}
 def test_public_backup_refused(self):
  r=self.release();r['draft']=False;s=Store()
  with self.assertRaises(w.core.DeliveryError):w.withdraw(s,'test',r)
  self.assertEqual(s.deleted,[])
 def test_backup_mismatch_refused(self):
  r=self.release();r['assets'][0]['digest']='bad';s=Store()
  with self.assertRaises(w.core.DeliveryError):w.withdraw(s,'test',r)
  self.assertEqual(s.deleted,[])
 def test_absent_objects_idempotent(self):
  s=Store();w.withdraw(s,'test',self.release());self.assertEqual(s.deleted,[])
 def test_wrong_content_never_deleted(self):
  s=Store();s.head_object=lambda **kw:{'ContentLength':17238481,'ETag':'tag'};s.get_object=lambda **kw:{'Body':io.BytesIO(b'wrong')}
  with self.assertRaises(w.core.DeliveryError):w.withdraw(s,'test',self.release())
  self.assertEqual(s.deleted,[])
if __name__=='__main__':unittest.main()
