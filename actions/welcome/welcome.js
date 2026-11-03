'use strict';

// The Legesher welcome: one comment when someone opens an issue or a pull
// request, one when their pull request is merged or closed. The shared wording
// lives in messages/; each repository adds its own sections under
// .github/welcome/ (see README.md).

const fs = require('fs');
const path = require('path');

const MESSAGES_DIR = path.join(__dirname, 'messages');

// People with write access are the team, and the team doesn't need welcoming.
const TEAM_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

const STANDINGS = ['first', 'new-to-repo', 'returning'];

const REFRESHER_SUMMARY = {
  issue: 'Want a refresher on how issues work here?',
  'pull-request': 'Want a refresher on how pull requests work here?',
};

// The repository's own file for each message.
const SECTION_FILE = {
  issue: 'issue.md',
  'pull-request': 'pull-request.md',
  merged: 'merged.md',
  closed: 'closed.md',
};

function marker(kind) {
  return `<!-- legesher-welcome:${kind} -->`;
}

function isBot(user) {
  if (!user) return true;
  return user.type === 'Bot' || /\[bot\]$/i.test(user.login || '');
}

function isTeam(association) {
  return TEAM_ASSOCIATIONS.has(String(association || '').toUpperCase());
}

// Which message an event calls for, or null when it calls for none.
function messageKind(eventName, payload) {
  const action = payload && payload.action;
  if (eventName === 'issues') {
    if (action === 'opened' && payload.issue && !payload.issue.pull_request) return 'issue';
    return null;
  }
  if ((eventName === 'pull_request_target' || eventName === 'pull_request') && payload.pull_request) {
    if (action === 'opened') return 'pull-request';
    if (action === 'closed') return payload.pull_request.merged ? 'merged' : 'closed';
  }
  return null;
}

// Issue forms start their titles with a tag such as "[Option]:" or
// "[New Language]:". The tag picks the form's section file, so it is held to
// a safe file name.
function formKey(title) {
  const match = /^\s*\[([^\]]+)\]/.exec(title || '');
  if (!match) return null;
  const key = match[1].trim().toLowerCase().replace(/\s+/g, '-');
  return /^[a-z0-9-]+$/.test(key) ? key : null;
}

function readMessage(name) {
  return fs.readFileSync(path.join(MESSAGES_DIR, `${name}.md`), 'utf8').trim();
}

function fill(template, vars) {
  return template.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (whole, name) => {
    if (!Object.prototype.hasOwnProperty.call(vars, name)) {
      throw new Error(`Unknown placeholder ${whole}`);
    }
    return vars[name];
  });
}

// Empty sections leave blank runs behind; fold them so the comment reads cleanly.
function tidy(text) {
  return text.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
}

function compose({ kind, standing, user, owner, repo, sections = {} }) {
  if (!STANDINGS.includes(standing)) throw new Error(`Unknown standing ${standing}`);
  const basic = { user, owner, repo };
  const section = (text) => (text ? fill(text, basic) : '');
  const vars = {
    ...basic,
    repo_section: section(sections.repo),
    form_section: section(sections.form),
    links: section(sections.links) || readMessage('links'),
  };

  let template;
  if (kind === 'issue' || kind === 'pull-request') {
    const greeting = readMessage(`${kind}-greeting-${standing}`);
    const guide = readMessage(`${kind}-guide`);
    template = standing === 'returning'
      ? `${greeting}\n\n<details>\n<summary>${REFRESHER_SUMMARY[kind]}</summary>\n\n${guide}\n\n</details>`
      : `${greeting}\n\n${guide}`;
  } else if (kind === 'merged') {
    template = readMessage(standing === 'returning' ? 'merged-returning' : 'merged-first');
  } else if (kind === 'closed') {
    template = readMessage('closed');
  } else {
    throw new Error(`Unknown message kind ${kind}`);
  }

  return `${tidy(fill(template, vars))}\n\n${marker(kind)}\n`;
}

async function readSection(github, { owner, repo, ref, filePath }) {
  try {
    const { data } = await github.rest.repos.getContent({ owner, repo, path: filePath, ref });
    if (Array.isArray(data) || data.type !== 'file' || typeof data.content !== 'string') return '';
    return Buffer.from(data.content, data.encoding || 'base64').toString('utf8').trim();
  } catch (error) {
    if (error && error.status === 404) return '';
    throw error;
  }
}

async function alreadyPosted(github, { owner, repo, number, kind }) {
  const comments = await github.paginate(github.rest.issues.listComments, {
    owner, repo, issue_number: number, per_page: 100,
  });
  return comments.some((comment) => (comment.body || '').includes(marker(kind)));
}

async function searchCount(github, q, { owner, repo, number }) {
  const { data } = await github.request('GET /search/issues', { q, per_page: 20 });
  const self = `/repos/${owner}/${repo}`;
  return data.items.filter(
    (item) => !(item.number === number && (item.repository_url || '').endsWith(self)),
  ).length;
}

// first: nothing from them anywhere in the org before this.
// new-to-repo: they've been here in another Legesher repository.
// returning: they've opened an issue or pull request in this one before.
// For merges, returning means an earlier merged pull request in this repository.
// A lookup that fails falls back to first, so nobody misses the full guide.
async function standingOf(github, { kind, owner, repo, login, number, core }) {
  try {
    if (kind === 'merged') {
      const earlier = await searchCount(
        github, `repo:${owner}/${repo} is:pr is:merged author:${login}`, { owner, repo, number },
      );
      return earlier > 0 ? 'returning' : 'first';
    }
    if (kind === 'closed') return 'first';

    const { data } = await github.rest.issues.listForRepo({
      owner, repo, creator: login, state: 'all', per_page: 5,
    });
    if (data.some((item) => item.number !== number)) return 'returning';

    // Search wants the type spelled out, so issues and pull requests are two queries.
    for (const type of ['is:issue', 'is:pr']) {
      const elsewhere = await searchCount(
        github, `org:${owner} ${type} author:${login}`, { owner, repo, number },
      );
      if (elsewhere > 0) return 'new-to-repo';
    }
    return 'first';
  } catch (error) {
    if (core) core.warning(`Could not look up earlier contributions (${error.message}); using the first-time message.`);
    return 'first';
  }
}

async function run({ github, context, core, sectionsPath = '.github/welcome' }) {
  const kind = messageKind(context.eventName, context.payload);
  if (!kind) {
    core.info(`Nothing to post for ${context.eventName}.${context.payload.action}.`);
    return null;
  }

  const thread = context.payload.issue || context.payload.pull_request;
  const author = thread.user;
  if (isBot(author)) {
    core.info('Opened by a bot; nothing to post.');
    return null;
  }
  if (isTeam(thread.author_association)) {
    core.info(`Opened by a maintainer (${thread.author_association}); nothing to post.`);
    return null;
  }
  const sender = context.payload.sender;
  if (kind === 'closed' && sender && sender.login === author.login) {
    core.info('Closed by its author; nothing to post.');
    return null;
  }

  const { owner, repo } = context.repo;
  const number = thread.number;
  if (await alreadyPosted(github, { owner, repo, number, kind })) {
    core.info('Already welcomed on this thread.');
    return null;
  }

  const login = author.login;
  const standing = await standingOf(github, { kind, owner, repo, login, number, core });

  const ref = (context.payload.repository && context.payload.repository.default_branch) || undefined;
  const read = (name) => readSection(github, { owner, repo, ref, filePath: `${sectionsPath}/${name}` });
  const sections = { repo: await read(SECTION_FILE[kind]) };
  if (kind === 'issue' || kind === 'pull-request') sections.links = await read('links.md');
  if (kind === 'issue') {
    const key = formKey(thread.title);
    if (key) sections.form = await read(`forms/${key}.md`);
  }

  const body = compose({ kind, standing, user: login, owner, repo, sections });
  await github.rest.issues.createComment({ owner, repo, issue_number: number, body });
  core.info(`Posted the ${standing} ${kind} message on #${number}.`);
  return body;
}

module.exports = {
  MESSAGES_DIR,
  STANDINGS,
  compose,
  fill,
  formKey,
  isBot,
  isTeam,
  marker,
  messageKind,
  readSection,
  run,
  standingOf,
  tidy,
};
