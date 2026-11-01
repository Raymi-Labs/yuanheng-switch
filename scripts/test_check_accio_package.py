import base64
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import stat
import struct
import sys
import tempfile
import unittest
from unittest.mock import patch
import zipfile

spec=importlib.util.spec_from_file_location("package",Path(__file__).with_name("check-accio-package.py"))
package=importlib.util.module_from_spec(spec)
spec.loader.exec_module(package)

class PackageTests(unittest.TestCase):
    def manifest(self,path="v0.37.2/Accio-0.37.2-20261031-1402-arm64.zip",size=3):
        return (f"version: 0.37.2\nfiles:\n  - url: {path}\n    sha512: {base64.b64encode(hashlib.sha512(b'zip').digest()).decode()}\n    size: {size}\n    arch: arm64\n").encode()

    def test_fixed_official_path_and_one_bounded_asset(self):
        version,url,_,size=package.arm_package(self.manifest())
        self.assertEqual(version,"0.37.2")
        self.assertEqual(size,3)
        self.assertTrue(url.startswith(package.ORIGIN+"/package/"))
        for data in [self.manifest("https://evil.test/a.zip"),self.manifest("../a.zip"),self.manifest(size=0),self.manifest(size=package.MAX_PACKAGE+1),self.manifest()+self.manifest(),b"<html>"]:
            with self.assertRaises(ValueError):package.arm_package(data)

    def test_metadata_limit_and_official_version_change_skip_package(self):
        with self.assertRaises(ValueError):package.read_metadata(io.BytesIO(b"x"*65537))
        response=io.BytesIO(self.manifest())
        response.status=200
        response.url=package.URL
        with patch.object(package.urllib.request,"build_opener") as opener:
            opener.return_value.open.return_value=response
            result=package.run("0.99.0")
        self.assertEqual(result["status"],"review_required")
        self.assertEqual(result["reason"],"official_version_changed")
        self.assertFalse(result["officialAppLaunched"])

    def archive(self,root,entries):
        p=root/"test.zip"
        with zipfile.ZipFile(p,"w") as z:
            for name,value,mode in entries:
                info=zipfile.ZipInfo(name);info.external_attr=mode<<16
                z.writestr(info,value)
        return p

    def test_archive_rejects_traversal_links_case_collisions_and_special_files(self):
        cases=[[("../escape",b"x",stat.S_IFREG)],
               [("Other.app/file",b"x",stat.S_IFREG)],
               [("Accio.app/x",b"/tmp",stat.S_IFLNK)],
               [("Accio.app/x",b"../outside",stat.S_IFLNK)],
               [("Accio.app/x",b"x",stat.S_IFREG),("Accio.app/X",b"x",stat.S_IFREG)],
               [("Accio.app/x",b"y",stat.S_IFLNK),("Accio.app/x/file",b"x",stat.S_IFREG)],
               [("Accio.app/x",b"x",stat.S_IFIFO)]]
        with tempfile.TemporaryDirectory() as d:
            for entries in cases:
                with self.assertRaises(ValueError):package.check_archive(self.archive(Path(d),entries))
            package.check_archive(self.archive(Path(d),[("Accio.app/Versions/A/file",b"x",stat.S_IFREG),("Accio.app/Versions/Current",b"A",stat.S_IFLNK)]))

    def test_download_integrity_size_and_redirect(self):
        class Response(io.BytesIO):
            status=200
            url=package.ORIGIN+"/package/x.zip"
        class Opener:
            def open(self,*args,**kwargs):return Response(b"zip")
        with tempfile.TemporaryDirectory() as d,patch.object(package.urllib.request,"build_opener",return_value=Opener()):
            package.download(Response.url,Path(d)/"ok",3,hashlib.sha512(b"zip").digest())
            for i,(size,digest) in enumerate([(2,b"x"*64),(4,b"x"*64),(3,b"x"*64)]):
                with self.assertRaises(ValueError):package.download(Response.url,Path(d)/str(i),size,digest)
            with self.assertRaises(ValueError):package.download("https://evil.test/x",Path(d)/"bad",3,b"x"*64)

    def test_asar_bounds_and_expected_entry_only(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);asar=root/"app.asar"
            entry={"size":3,"offset":"0"}
            h=json.dumps({"files":{"out":{"files":{"main":{"files":{"gateway-worker.js":entry}}}}}}).encode()
            asar.write_bytes(struct.pack("<4I",4,len(h)+8,len(h)+4,len(h))+h+b"abc")
            self.assertEqual(package.extract_worker(asar,root/"worker"),hashlib.sha256(b"abc").hexdigest())
            asar.write_bytes(asar.read_bytes()[:-1])
            with self.assertRaises(ValueError):package.extract_worker(asar,root/"bad")

    def test_timeout_reaps_child_and_sanitized_report(self):
        with self.assertRaises(TimeoutError):package.bounded([sys.executable,"-c","import time; time.sleep(20)"],0.1)
        with patch.object(package.urllib.request,"build_opener",side_effect=RuntimeError("private_token_secret")):
            result=package.run()
        self.assertEqual(result["status"],"check_failed")
        self.assertFalse(result["configurationBlocked"])
        self.assertNotIn("private_token",json.dumps(result))

    def test_failed_signature_never_runs_protocol_and_removes_temporary_package(self):
        response=io.BytesIO(self.manifest())
        response.status=200;response.url=package.URL
        directories=[];commands=[]
        def download(url,path,*args):
            directories.append(path.parent)
            path.write_bytes(b"synthetic")
        def bounded(command,*args):
            commands.append(command[0])
            return (1 if command[0]=="/usr/bin/codesign" else 0),"private failure"
        with patch.object(package.urllib.request,"build_opener") as opener,patch.object(package.sys,"platform","darwin"),patch.object(package,"download",side_effect=download),patch.object(package,"check_archive"),patch.object(package,"bounded",side_effect=bounded):
            opener.return_value.open.return_value=response
            result=package.run()
        self.assertEqual(result["failedStage"],"official_identity")
        self.assertNotIn("node",commands)
        self.assertTrue(directories)
        self.assertTrue(all(not p.exists() for p in directories))

    def test_timeout_terminates_spawned_descendant(self):
        with tempfile.TemporaryDirectory() as d:
            marker=Path(d)/"pid"
            script="import subprocess,sys,time; from pathlib import Path; p=subprocess.Popen([sys.executable,'-c','import time;time.sleep(20)']); Path(sys.argv[1]).write_text(str(p.pid)); time.sleep(20)"
            with self.assertRaises(TimeoutError):package.bounded([sys.executable,"-c",script,str(marker)],0.5)
            pid=int(marker.read_text())
            # Kernel process-group kill has completed; a brief zombie state is
            # allowed until the OS reaper collects the orphan, but not running.
            code,text=package.bounded(["/bin/ps","-o","stat=","-p",str(pid)],2)
            self.assertTrue(code!=0 or text.strip().startswith("Z"))

if __name__=="__main__":unittest.main()
