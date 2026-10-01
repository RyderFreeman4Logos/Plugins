# Local equivalent of .github/workflows/codex.yml; never invokes GitHub Actions.
codex-fast node="":
    bash codex/scripts/test-offline.sh {{node}}
    git diff --check

# Release matrix is explicit: other Node versions do not substitute for 20/22.
codex-full node20 node22:
    test "$({{node20}} -p 'process.versions.node.split(".")[0]')" = 20
    test "$({{node22}} -p 'process.versions.node.split(".")[0]')" = 22
    bash codex/scripts/test-offline.sh {{node20}}
    bash codex/scripts/test-offline.sh {{node22}}
