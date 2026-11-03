# Legesher welcome

Welcomes everyone who opens an issue or pull request in a Legesher repository, and celebrates
their merges. The wording everyone shares lives here, in [`messages/`](messages/). Each repository
adds its own sections, so people can see what that repository is about and where help is wanted.

## What it posts

| When | First time | Coming back |
| --- | --- | --- |
| An issue is opened | The welcome and the full guide to what happens next | "Welcome back," with the guide folded into a refresher they can expand |
| A pull request is opened | The welcome and the full guide to review and merging | "Welcome back," with the guide folded into a refresher |
| A pull request is merged | The celebration | A shorter thank you |
| A pull request is closed without merging | A kind note and an invitation to keep going | The same |

"First time" means nothing from them in this repository yet. Someone who has contributed
elsewhere in Legesher but is new to this repository is welcomed back to Legesher and to the
repository, with the full guide open.

Nothing is posted for bots, for people with write access to the repository, or for a pull request
its author closes. Each message is posted once per thread.

## Using it in a repository

Add `.github/workflows/welcome.yml`:

```yaml
name: Welcome

on:
  issues:
    types: [opened]
  # Runs from the default branch so it can comment on pull requests from
  # forks. It never checks out or runs code from the pull request.
  pull_request_target:  # zizmor: ignore[dangerous-triggers]
    types: [opened, closed]

permissions: {}

jobs:
  welcome:
    name: Welcome
    runs-on: ubuntu-latest
    permissions:
      contents: read
      issues: write
      pull-requests: write
    steps:
      - uses: legesher/.github/actions/welcome@<commit sha> # main
```

Then add whichever sections the repository needs under `.github/welcome/`. Every file is
optional; a missing file simply leaves that part out.

| File | Where it appears |
| --- | --- |
| `issue.md` | In the issue guide: what this repository is and where help is wanted |
| `pull-request.md` | In the pull request guide: anything a contributor needs before merge here |
| `merged.md` | In the merge message: what their contribution becomes |
| `closed.md` | In the closed-without-merging note |
| `links.md` | Replaces the default "Good to know" links |
| `forms/<tag>.md` | In the issue guide, for issues opened from a form whose title starts with `[<Tag>]:`. `[New Language]:` reads `forms/new-language.md` |

Sections are read from the repository's default branch, so a pull request can't change the
message it receives. They may use `{{user}}`, `{{owner}}` and `{{repo}}`.

## Changing the wording

Edit the files in [`messages/`](messages/), then run the tests:

```sh
node --test 'actions/welcome/test/*.test.js'
node actions/welcome/check-links.js actions/welcome/messages
```

Repositories pin this action to a commit, so a change reaches each repository when its pin is
updated.
