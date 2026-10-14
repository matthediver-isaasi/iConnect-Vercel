#!/usr/bin/env python3
"""Offline safety and pinned-output checks; no network or database."""
import hashlib
import importlib.util
import json
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("review", Path(__file__).with_name("prepare-bnms-missing-150-review.py"))
review = importlib.util.module_from_spec(spec)
spec.loader.exec_module(review)


class ReviewTests(unittest.TestCase):
    def test_dates(self):
        self.assertEqual(review.expiry("4/8/27"), "2027-04-08")
        self.assertEqual(review.expiry("08/04/2027"), "2027-04-08")
        self.assertIsNone(review.expiry("31/02/2027"))
        self.assertIsNone(review.expiry("Member Since"))

    def test_identity_conflict_is_not_corroboration(self):
        audit = {"expiry": "2027-04-08", "memberClass": "Full", "legacyMembershipType": "Full Membership UK"}
        source = {"legacyId": "other", "email": "fixture@example.invalid", "expiry": audit["expiry"],
                  "class": "Full", "type": "Full Membership UK", "status": "Active"}
        state, rows = review.assess_source(audit, {"preferences": {"ym_web_site_member_id": "expected"}},
                                           [source], source["email"])
        self.assertEqual(state, "source_conflict_requires_review")
        self.assertTrue(rows[0]["identityConflict"])

    def test_pinned_private_output(self):
        root = review.ROOT
        if not (root / "final/proposal.json").exists():
            self.skipTest("Private output not present; fixtures still run")
        proposal = json.loads((root / "final/proposal.json").read_bytes())
        self.assertEqual(proposal["snapshotSha256"], hashlib.sha256((root / "snapshot.json").read_bytes()).hexdigest())
        self.assertFalse(proposal["approved"])
        self.assertEqual(len(proposal["members"]), 150)
        self.assertEqual(len({r["memberId"] for r in proposal["members"]}), 150)
        for file in proposal["files"]:
            self.assertEqual(file["sha256"], hashlib.sha256(Path(file["path"]).read_bytes()).hexdigest())
        for member in proposal["members"]:
            self.assertEqual(member["decision"], "HOLD_PENDING_EXPLICIT_APPROVAL")
            self.assertEqual(member["paidEntitlement"], "unresolved")
            self.assertGreater(member["retainedExpiry"], "2026-12-31")
            self.assertFalse(member["liveDrift"])
            self.assertEqual(member["liveSourceSha256"], review.sha(review.canonical(member["liveSource"])))
            for field in ["termStartDate", "historicalAmount", "invoiceId", "paymentStatus", "paidAt",
                          "renewalPolicy", "billingConsent"]:
                self.assertIsNone(member["conditionalRepair"][field])
            self.assertTrue(all(i["originalWorkbookVerified"] for i in member["invoiceEvidence"]))


if __name__ == "__main__":
    unittest.main()
