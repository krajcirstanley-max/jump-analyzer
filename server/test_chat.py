"""chat.py against a fake `claude`: validation, the prompt, token isolation, failures.
Run: python server/test_chat.py"""
import json
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import chat as C  # noqa: E402


class Run:
    def __init__(self, stdout='{"result": "Kontakt máš 142 ms. „stlač zem pod seba“"}', stderr="", raise_timeout=False):
        self.stdout, self.stderr, self.raise_timeout, self.calls = stdout, stderr, raise_timeout, []
    def __call__(self, args, **kw):
        self.calls.append((args, kw))
        if self.raise_timeout:
            raise subprocess.TimeoutExpired(args, 1)
        return subprocess.CompletedProcess(args, 0, self.stdout, self.stderr)


def ok_payload():
    return {"jump": {"athlete": "Stanley", "metrics": [{"key": "contactTO", "value": 142}]}, "messages": [{"role": "user", "text": "Chcem byť kratšie na doske, čo mám robiť?"}]}


def test_answer_goes_through_the_cli_with_only_that_token():
    run = Run()
    out = C.answer(ok_payload(), token="tok-s", knowledge="## Coaching SOP", run=run)
    assert out == {"answer": "Kontakt máš 142 ms. „stlač zem pod seba“"}
    args, kw = run.calls[0]
    assert "--safe-mode" in args and "--tools" in args and args[args.index("--model") + 1] == C.MODEL
    assert "Coaching SOP" in args[args.index("--system-prompt") + 1]
    assert kw["env"]["CLAUDE_CODE_OAUTH_TOKEN"] == "tok-s" and "ANTHROPIC_API_KEY" not in kw["env"]
    assert "contactTO" in kw["input"] and kw["input"].rstrip().endswith("Odpovedz na poslednú otázku atléta.")


def test_validation():
    for bad in [None, {}, {"messages": []}, {"messages": [{"role": "assistant", "text": "x"}]},
                {"messages": [{"role": "user", "text": "  "}]}, {"messages": [{"role": "x", "text": "a"}]},
                {"messages": [{"role": "user", "text": "a"}] * 21}, {"jump": {"x": "y" * 30000}, "messages": [{"role": "user", "text": "a"}]}]:
        try:
            C.validate(bad)
        except ValueError:
            continue
        raise AssertionError(f"accepted {bad!r}")


def test_no_token_no_answer_and_errors_hide_the_token():
    try:
        C.answer(ok_payload(), token=None, run=Run())
        raise AssertionError("answered without a token")
    except RuntimeError:
        pass
    run = Run(stdout="", stderr="auth failed for tok-secret")
    try:
        C.answer(ok_payload(), token="tok-secret", run=run)
        raise AssertionError("no answer should raise")
    except RuntimeError as e:
        assert "tok-secret" not in str(e)
    try:
        C.answer(ok_payload(), token="t", run=Run(raise_timeout=True))
        raise AssertionError("timeout should raise")
    except RuntimeError:
        pass


def test_an_error_result_is_not_an_answer():
    for stdout in ['{"is_error": true, "result": "Invalid API key"}']:
        try:
            C.answer(ok_payload(), token="t", run=Run(stdout=stdout))
            raise AssertionError("error text came back as an answer")
        except RuntimeError as e:
            assert "Invalid" not in str(e)


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print("ok  ", name)
