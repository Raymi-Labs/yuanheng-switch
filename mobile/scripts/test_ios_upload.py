import json
import unittest
from upload_ios_store import check_response


class UploadTests(unittest.TestCase):
    def test_explicit_success(self):
        for action, verb in (("upload", "uploading"), ("validate", "validating")):
            check_response(json.dumps({"success-message": f"No errors {verb} archive."}), action, 0)

    def test_zero_exit_is_not_success(self):
        for result in ({}, {"product-errors": [{"code": 409}]},
                       {"success-message": "No errors validating archive."}):
            with self.subTest(result=result), self.assertRaises(ValueError):
                check_response(json.dumps(result), "upload", 0)

    def test_rejects_conflicting_or_invalid_response(self):
        success = {"success-message": "No errors uploading archive."}
        for result, code in ((success, 1), ({**success, "product-errors": ["rejected"]}, 0)):
            with self.subTest(result=result), self.assertRaises(ValueError):
                check_response(json.dumps(result), "upload", code)
        with self.assertRaises(ValueError):
            check_response("not json", "upload", 0)


if __name__ == "__main__":
    unittest.main()
