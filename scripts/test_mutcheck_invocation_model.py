"""Negative controls for mutation catch attribution; no child processes required."""
import runpy
import unittest
from pathlib import Path

# Load the standalone script by path, independent of the caller's import root.
helpers = runpy.run_path(str(Path(__file__).with_name("mutcheck_invocation_model.py")))
EXPECTED_FAILURES = helpers["EXPECTED_FAILURES"]
assertion_failures = helpers["assertion_failures"]
mutant_caught = helpers["mutant_caught"]


def tap_failure(name: str, code: str = "ERR_ASSERTION") -> str:
    return (f"    not ok 1 - {name}\n      ---\n      type: 'test'\n"
            f"      code: '{code}'\n      ...\n")


class MutationAttributionTests(unittest.TestCase):
    def test_expected_assertion_is_caught_for_each_mutant(self) -> None:
        for label, names in EXPECTED_FAILURES.items():
            with self.subTest(label=label):
                output = "".join(tap_failure(name) for name in names)
                self.assertTrue(mutant_caught(label, 1, output))
                self.assertFalse(mutant_caught(label, 0, output))

    def test_unrelated_assertion_does_not_credit_expected_test(self) -> None:
        name = next(iter(EXPECTED_FAILURES["routing-bypass"]))
        output = tap_failure(name, "ERR_MODULE_NOT_FOUND") + tap_failure("unrelated test")
        self.assertEqual(assertion_failures(output), {"unrelated test"})
        self.assertFalse(mutant_caught("routing-bypass", 1, output))

    def test_suite_failure_and_prose_marker_do_not_count(self) -> None:
        name = next(iter(EXPECTED_FAILURES["routing-bypass"]))
        output = tap_failure(name, "ERR_TEST_FAILURE") + "# ERR_ASSERTION appeared elsewhere\n"
        self.assertFalse(mutant_caught("routing-bypass", 1, output))

    def test_nested_assertion_code_does_not_count_as_top_level_failure(self) -> None:
        name = next(iter(EXPECTED_FAILURES["routing-bypass"]))
        output = tap_failure(name, "ERR_TEST_FAILURE").replace(
            "      ...", "      cause:\n        code: 'ERR_ASSERTION'\n      ...")
        self.assertFalse(mutant_caught("routing-bypass", 1, output))

    def test_all_append_shapes_must_fail(self) -> None:
        names = sorted(EXPECTED_FAILURES["append-routing-bypass"])
        output = "".join(tap_failure(name) for name in names[:-1])
        self.assertFalse(mutant_caught("append-routing-bypass", 1, output))


if __name__ == "__main__":
    unittest.main()
