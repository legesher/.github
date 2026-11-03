'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const welcome = require('../welcome.js');
const { linksIn } = require('../check-links.js');

const MESSAGE_FILES = fs.readdirSync(welcome.MESSAGES_DIR).filter((name) => name.endsWith('.md'));
const KNOWN_PLACEHOLDERS = new Set(['user', 'owner', 'repo', 'repo_section', 'form_section', 'links']);
// Hosts the old welcome bot linked to. They no longer resolve.
const DEAD_LINKS = [/docs\.legesher\.io/, /legesher\.io\/dreamteam/];

// Combining-mark scripts: a decode that goes through Latin-1 mangles these.
const UNICODE_SAMPLES = {
  devanagari: 'नमस्ते, दुनिया',
  sinhalaZwj: 'ශ්‍රී ලංකාව',
  vocalisedArabic: 'مَرْحَبًا بِالْعَالَمِ',
  pointedHebrew: 'שָׁלוֹם עוֹלָם',
  thai: 'สวัสดีชาวโลก',
};

// ---------------------------------------------------------------------------
// A stand-in for the Octokit client github-script hands us.

function fakeGithub({ comments = [], repoItems = [], search = {}, files = {}, searchError, contentError } = {}) {
  const calls = { created: [], contentPaths: [], searches: [], refs: [] };
  const listComments = async () => ({ data: comments });
  const github = {
    calls,
    paginate: async (method, params) => (await method(params)).data,
    request: async (route, { q }) => {
      calls.searches.push(q);
      if (searchError) throw searchError;
      const match = Object.keys(search).find((needle) => q.includes(needle));
      return { data: { items: match ? search[match] : [] } };
    },
    rest: {
      issues: {
        listComments,
        listForRepo: async () => ({ data: repoItems }),
        createComment: async (params) => {
          calls.created.push(params);
          return { data: {} };
        },
      },
      repos: {
        getContent: async ({ path: filePath, ref }) => {
          calls.contentPaths.push(filePath);
          calls.refs.push(ref);
          if (contentError) throw contentError;
          if (files[filePath] && typeof files[filePath] === 'object') return { data: files[filePath] };
          if (!(filePath in files)) {
            const error = new Error('Not Found');
            error.status = 404;
            throw error;
          }
          return {
            data: { type: 'file', encoding: 'base64', content: Buffer.from(files[filePath], 'utf8').toString('base64') },
          };
        },
      },
    },
  };
  return github;
}

function fakeCore() {
  const log = { info: [], warning: [] };
  return { log, info: (m) => log.info.push(m), warning: (m) => log.warning.push(m) };
}

const REPO = { owner: 'legesher', repo: 'language-packs' };
const repoItem = (number, pull) => ({
  number,
  repository_url: 'https://api.github.com/repos/legesher/language-packs',
  ...(pull ? { pull_request: { merged_at: pull === 'merged' ? '2026-10-01T00:00:00Z' : null } } : {}),
});

function issueContext({ login = 'amara', association = 'NONE', title = '[Option]: def in Swahili', type = 'User' } = {}) {
  return {
    eventName: 'issues',
    repo: REPO,
    payload: {
      action: 'opened',
      repository: { default_branch: 'main' },
      sender: { login },
      issue: { number: 42, title, user: { login, type }, author_association: association },
    },
  };
}

function pullContext({ action = 'opened', merged = false, login = 'amara', sender = 'madiedgar', association = 'CONTRIBUTOR' } = {}) {
  return {
    eventName: 'pull_request_target',
    repo: REPO,
    payload: {
      action,
      repository: { default_branch: 'main' },
      sender: { login: sender },
      pull_request: { number: 7, title: 'docs: fix a link', merged, user: { login, type: 'User' }, author_association: association },
    },
  };
}

// ---------------------------------------------------------------------------
// Which events get a message, and from whom.

test('messageKind maps each event to its message', () => {
  assert.equal(welcome.messageKind('issues', { action: 'opened', issue: {} }), 'issue');
  assert.equal(welcome.messageKind('issues', { action: 'edited', issue: {} }), null);
  assert.equal(welcome.messageKind('issues', { action: 'opened', issue: { pull_request: {} } }), null);
  const pr = (action, merged) => ({ action, pull_request: { merged } });
  assert.equal(welcome.messageKind('pull_request_target', pr('opened', false)), 'pull-request');
  assert.equal(welcome.messageKind('pull_request_target', pr('closed', true)), 'merged');
  assert.equal(welcome.messageKind('pull_request_target', pr('closed', false)), 'closed');
  assert.equal(welcome.messageKind('pull_request_target', pr('synchronize', false)), null);
  assert.equal(welcome.messageKind('push', {}), null);
  // pull_request gets a read-only token on forks, so it can't comment; only pull_request_target can.
  assert.equal(welcome.messageKind('pull_request', pr('opened', false)), null);
});

test('bots and the team are recognised', () => {
  assert.equal(welcome.isBot({ login: 'dependabot[bot]', type: 'Bot' }), true);
  assert.equal(welcome.isBot({ login: 'renovate[bot]', type: 'User' }), true);
  assert.equal(welcome.isBot({ login: 'amara', type: 'User' }), false);
  for (const association of ['OWNER', 'MEMBER', 'COLLABORATOR']) assert.equal(welcome.isTeam(association), true);
  for (const association of ['CONTRIBUTOR', 'FIRST_TIME_CONTRIBUTOR', 'FIRST_TIMER', 'NONE', undefined]) {
    assert.equal(welcome.isTeam(association), false);
  }
});

test('formKey reads the issue-form tag and refuses anything that is not a safe file name', () => {
  assert.equal(welcome.formKey('[Option]: def in Swahili'), 'option');
  assert.equal(welcome.formKey('[New Language]: Yoruba (Python)'), 'new-language');
  assert.equal(welcome.formKey('  [Reviewer]: Sinhala'), 'reviewer');
  assert.equal(welcome.formKey('Option: no brackets'), null);
  assert.equal(welcome.formKey('[../../README]: escape'), null);
  assert.equal(welcome.formKey(`[${UNICODE_SAMPLES.devanagari}]: tag in Devanagari`), null);
  assert.equal(welcome.formKey(undefined), null);
});

// ---------------------------------------------------------------------------
// The shared wording, checked file by file from the real messages folder.

test('every kind has a greeting for every standing', () => {
  for (const kind of ['issue', 'pull-request']) {
    for (const standing of welcome.STANDINGS) {
      assert.ok(MESSAGE_FILES.includes(`${kind}-greeting-${standing}.md`), `${kind}-greeting-${standing}.md is missing`);
    }
    assert.ok(MESSAGE_FILES.includes(`${kind}-guide.md`), `${kind}-guide.md is missing`);
  }
  for (const name of ['merged-first.md', 'merged-returning.md', 'closed.md', 'links.md']) {
    assert.ok(MESSAGE_FILES.includes(name), `${name} is missing`);
  }
});

for (const name of MESSAGE_FILES) {
  const text = fs.readFileSync(path.join(welcome.MESSAGES_DIR, name), 'utf8');

  test(`${name}: no em dashes`, () => {
    assert.ok(!text.includes('—'), `${name} contains an em dash`);
  });

  test(`${name}: only known placeholders`, () => {
    for (const [, placeholder] of text.matchAll(/\{\{\s*([^}]*?)\s*\}\}/g)) {
      assert.ok(KNOWN_PLACEHOLDERS.has(placeholder), `${name} uses unknown placeholder {{${placeholder}}}`);
    }
  });

  test(`${name}: links are https and avoid the hosts that went dead`, () => {
    for (const url of linksIn(text)) {
      assert.ok(url.startsWith('https://'), `${name} links over plain http: ${url}`);
      for (const dead of DEAD_LINKS) assert.ok(!dead.test(url), `${name} links to a dead page: ${url}`);
    }
  });

  if (/greeting|merged|closed/.test(name)) {
    test(`${name}: addresses the person by name`, () => {
      assert.ok(text.includes('@{{user}}'), `${name} never mentions @{{user}}`);
    });
  }
}

// ---------------------------------------------------------------------------
// Putting a message together.

const base = { user: 'amara', owner: 'legesher', repo: 'language-packs' };

test('a first-timer sees the whole guide, open', () => {
  const body = welcome.compose({ ...base, kind: 'issue', standing: 'first', sections: { form: '### About your word' } });
  assert.match(body, /welcome to Legesher, and thank you for opening your first issue/);
  assert.match(body, /### What happens next/);
  assert.match(body, /### About your word/);
  assert.doesNotMatch(body, /<details>/);
  assert.ok(body.trimEnd().endsWith(welcome.marker('issue')));
});

test('a returning contributor gets the guide folded into a refresher', () => {
  const body = welcome.compose({ ...base, kind: 'pull-request', standing: 'returning' });
  assert.match(body, /^Welcome back, @amara!/);
  const details = /<details>\n<summary>(.+)<\/summary>\n\n([\s\S]+)\n\n<\/details>/.exec(body);
  assert.ok(details, 'no <details> block with a blank line after the summary');
  assert.match(details[1], /refresher on how pull requests work/);
  assert.match(details[2], /### What happens next/);
  assert.equal(body.indexOf('### What happens next') > body.indexOf('<details>'), true);
});

test('someone new to this repository but not to Legesher is welcomed back and to the repository', () => {
  const body = welcome.compose({ ...base, kind: 'issue', standing: 'new-to-repo' });
  assert.match(body, /welcome back to Legesher, and welcome to language-packs!/);
  assert.doesNotMatch(body, /<details>/);
});

test('merges celebrate the first time and thank every time after', () => {
  const first = welcome.compose({ ...base, kind: 'merged', standing: 'first', sections: { repo: 'Your words are kept.' } });
  assert.match(first, /You've contributed to open source\. You've made our community even better\. We want to celebrate you\./);
  assert.match(first, /Your words are kept\./);
  const again = welcome.compose({ ...base, kind: 'merged', standing: 'returning' });
  assert.match(again, /^Merged! 🎉 Thank you again, @amara\./);
  assert.doesNotMatch(again, /celebrate you/);
});

test('empty sections leave no gaps and no placeholders behind', () => {
  for (const kind of ['issue', 'pull-request', 'merged', 'closed']) {
    for (const standing of welcome.STANDINGS) {
      const body = welcome.compose({ ...base, kind, standing });
      assert.doesNotMatch(body, /\{\{/, `${kind}/${standing} left a placeholder`);
      assert.doesNotMatch(body, /\n{3,}/, `${kind}/${standing} left a blank run`);
    }
  }
});

test('a repository can replace the default links, and sections may use the placeholders', () => {
  const body = welcome.compose({
    ...base, kind: 'issue', standing: 'first',
    sections: { links: '- [Reviewing guide](https://github.com/{{owner}}/{{repo}}/blob/main/REVIEWING.md)' },
  });
  assert.match(body, /https:\/\/github\.com\/legesher\/language-packs\/blob\/main\/REVIEWING\.md/);
  assert.doesNotMatch(body, /COMMUNITY_GUIDELINES/);
});

test('a repository section may quote template syntax; only our placeholders are filled', () => {
  const body = welcome.compose({
    ...base, kind: 'issue', standing: 'first',
    sections: { repo: 'Hi {{user}}, Jinja looks like `{{ name }}`.' },
  });
  assert.match(body, /Hi amara, Jinja looks like `\{\{ name \}\}`\./);
});

test('the shared wording stays strict about placeholders', () => {
  assert.throws(() => welcome.fill('Hi {{usr}}', { user: 'amara' }), /Unknown placeholder \{\{usr\}\}/);
});

test('a section keeps its own trailing-space line breaks', () => {
  const body = welcome.compose({ ...base, kind: 'merged', standing: 'first', sections: { repo: 'Line one  \nLine two' } });
  assert.ok(body.includes('Line one  \nLine two'));
});

for (const [script, sample] of Object.entries(UNICODE_SAMPLES)) {
  test(`a section written in ${script} reaches the comment byte for byte`, async () => {
    const github = fakeGithub({ files: { '.github/welcome/issue.md': `### ${sample}` } });
    const text = await welcome.readSection(github, { owner: 'legesher', repo: 'language-packs', ref: 'main', filePath: '.github/welcome/issue.md' });
    assert.equal(text, `### ${sample}`);
    const body = welcome.compose({ ...base, kind: 'issue', standing: 'first', sections: { repo: text } });
    assert.ok(body.includes(sample), `${script} text was altered on the way through`);
  });
}

// ---------------------------------------------------------------------------
// The whole run against a fake client.

test('a first issue posts the full welcome with the repository and form sections', async () => {
  const github = fakeGithub({
    repoItems: [repoItem(42)],
    files: {
      '.github/welcome/issue.md': '### About this repository',
      '.github/welcome/forms/option.md': '### What happens to your word',
    },
  });
  const core = fakeCore();
  const body = await welcome.run({ github, context: issueContext(), core });
  assert.equal(github.calls.created.length, 1);
  assert.equal(github.calls.created[0].issue_number, 42);
  assert.equal(github.calls.created[0].body, body);
  assert.match(body, /thank you for opening your first issue/);
  assert.match(body, /### About this repository/);
  assert.match(body, /### What happens to your word/);
  assert.deepEqual(new Set(github.calls.refs), new Set(['main']), 'sections must come from the default branch');
  assert.ok(github.calls.contentPaths.includes('.github/welcome/forms/option.md'));
});

test('an issue from someone with earlier issues here gets the returning message', async () => {
  const github = fakeGithub({ repoItems: [repoItem(42), repoItem(3)] });
  const body = await welcome.run({ github, context: issueContext(), core: fakeCore() });
  assert.match(body, /^Welcome back, @amara!/);
  assert.deepEqual(github.calls.searches, [], 'no org search is needed once the repository answers');
});

test('an issue from someone known elsewhere in the org is new-to-repo', async () => {
  const github = fakeGithub({
    repoItems: [repoItem(42)],
    search: { 'is:pr': [{ number: 9, repository_url: 'https://api.github.com/repos/legesher/legesher' }] },
  });
  const body = await welcome.run({ github, context: issueContext(), core: fakeCore() });
  assert.match(body, /welcome back to Legesher, and welcome to language-packs/);
  assert.ok(github.calls.searches.every((q) => /is:(issue|pr)/.test(q)), 'every search names its type');
});

test('nothing is posted twice on the same thread', async () => {
  const github = fakeGithub({ comments: [{ body: `Hello\n\n${welcome.marker('issue')}\n` }] });
  assert.equal(await welcome.run({ github, context: issueContext(), core: fakeCore() }), null);
  assert.equal(github.calls.created.length, 0);
});

test('bots and the team are not welcomed', async () => {
  for (const context of [
    issueContext({ login: 'dependabot[bot]', type: 'Bot' }),
    issueContext({ association: 'MEMBER' }),
    pullContext({ association: 'OWNER' }),
    pullContext({ action: 'closed', merged: true, association: 'COLLABORATOR' }),
  ]) {
    const github = fakeGithub();
    assert.equal(await welcome.run({ github, context, core: fakeCore() }), null);
    assert.equal(github.calls.created.length, 0);
  }
});

test('a pull request its author closes gets no message; one a maintainer closes gets the kind note', async () => {
  const own = fakeGithub();
  assert.equal(await welcome.run({ github: own, context: pullContext({ action: 'closed', sender: 'amara' }), core: fakeCore() }), null);
  assert.equal(own.calls.created.length, 0);

  const theirs = fakeGithub({ files: { '.github/welcome/closed.md': 'Open an issue any time.' } });
  const body = await welcome.run({ github: theirs, context: pullContext({ action: 'closed' }), core: fakeCore() });
  assert.match(body, /We've closed it without merging this time/);
  assert.match(body, /Open an issue any time\./);
});

test('a merge after earlier merges says thank you again; a first merge celebrates', async () => {
  const merged = pullContext({ action: 'closed', merged: true });
  const again = fakeGithub({ repoItems: [repoItem(7, 'merged'), repoItem(2, 'merged')] });
  assert.match(await welcome.run({ github: again, context: merged, core: fakeCore() }), /^Merged! 🎉/);

  // The merge being welcomed, an open pull request and an issue are not earlier merges.
  const first = fakeGithub({ repoItems: [repoItem(7, 'merged'), repoItem(5, 'open'), repoItem(3)] });
  const body = await welcome.run({ github: first, context: merged, core: fakeCore() });
  assert.match(body, /We want to celebrate you\./);
});

test('a first pull request from someone who has only opened issues here is a first pull request', async () => {
  const github = fakeGithub({ repoItems: [repoItem(7, 'open'), repoItem(3)] });
  const body = await welcome.run({ github, context: pullContext(), core: fakeCore() });
  assert.match(body, /thank you so much for opening your first pull request here/);
  assert.doesNotMatch(body, /another pull request/);
  assert.ok(github.calls.searches.every((q) => q.includes('is:pr')), 'an issue elsewhere is not an earlier pull request');
});

test('a pull request after an earlier pull request here is welcomed back', async () => {
  const github = fakeGithub({ repoItems: [repoItem(7, 'open'), repoItem(4, 'open')] });
  assert.match(await welcome.run({ github, context: pullContext(), core: fakeCore() }), /another pull request/);
});

test('a section that cannot be read is left out, and the welcome still posts', async () => {
  const unavailable = Object.assign(new Error('Bad Gateway'), { status: 502 });
  const github = fakeGithub({ repoItems: [repoItem(42)], contentError: unavailable });
  const core = fakeCore();
  const body = await welcome.run({ github, context: issueContext(), core });
  assert.equal(github.calls.created.length, 1);
  assert.match(body, /### What happens next/);
  assert.match(core.log.warning.join('\n'), /Bad Gateway/);
});

test('a section too large for the contents API is left out', async () => {
  const github = fakeGithub({ files: { '.github/welcome/issue.md': { type: 'file', encoding: 'none', content: '' } } });
  const core = fakeCore();
  const text = await welcome.readSection(github, { owner: 'legesher', repo: 'language-packs', ref: 'main', filePath: '.github/welcome/issue.md', core });
  assert.equal(text, '');
  assert.deepEqual(core.log.warning, [], 'a file the API will not inline is expected, not an error');
});

test('a failed lookup falls back to the first-time message and says why', async () => {
  const github = fakeGithub({ repoItems: [repoItem(42)], searchError: new Error('rate limited') });
  const core = fakeCore();
  const body = await welcome.run({ github, context: issueContext(), core });
  assert.match(body, /thank you for opening your first issue/);
  assert.match(core.log.warning.join('\n'), /rate limited/);
});
