from __future__ import annotations

import unittest

from services.module_detector import detect_module, detect_module_from_case_id


class ModuleDetectorTest(unittest.TestCase):
    def test_does_not_match_alias_inside_larger_word(self) -> None:
        self.assertIsNone(detect_module("Medical Director (OLD)"))
        self.assertIsNone(detect_module("Medical Director (NEW)"))

    def test_detects_ire_alias_as_standalone_token(self) -> None:
        self.assertEqual(detect_module("IRE"), "ire_mgmt")
        self.assertEqual(detect_module("EXRM Case no"), "ire_mgmt")
        self.assertEqual(detect_module("Independent Review"), "ire_mgmt")

    def test_detects_bare_c_prefix_as_ctm(self) -> None:
        self.assertEqual(detect_module_from_case_id("C2603504448"), "ctm_mgmt")

    def test_detects_gr_prefix_as_grievance(self) -> None:
        self.assertEqual(detect_module_from_case_id("GR2611072972"), "grievance_mgmt")


if __name__ == "__main__":
    unittest.main()
