import { GITHUB, Layout } from '../components/Layout';
import runsShot from '../assets/panel-runs.webp';
import runShot from '../assets/panel-run.webp';
import runLogShot from '../assets/panel-run-log.webp';
import inboxShot from '../assets/panel-inbox.webp';
import pipelineShot from '../assets/panel-pipeline-stages.webp';
import mobileTasksShot from '../assets/mobile-task-statuses.webp';
import mobileRunShot from '../assets/mobile-run-detail.webp';

type DocLink = { slug: string; title: string; description: string };

const FEATURES: Array<{ title: string; text: string }> = [
  {
    title: 'Pipelines',
    text: 'A pipeline is a list of stages, each played by an agent role with its own prompt and model: investigate, decide, fix, review. Scripts run before and after, and a stage can return a machine-readable pass/fail verdict.',
  },
  {
    title: 'Your own workers',
    text: 'Agents run where your code and credentials already are. A worker clones a repository for each run or works in a prepared directory, on the host or inside Docker. The server never holds the agent’s subscription.',
  },
  {
    title: 'Review before push',
    text: 'Nothing reaches a remote on its own unless you allow it. Diffs wait for approval, push rights are granted per worker and per directory, and anything already in a directory is stashed, never mixed into the agent’s work.',
  },
  {
    title: 'Workflows',
    text: 'A visual graph decides when to run: on a new task, a comment, a push or a failed CI build. Approval nodes wait for a person for as long as it takes and survive restarts and deploys.',
  },
  {
    title: 'Inbox & mobile app',
    text: 'Everything waiting on a person — an agent’s question, a diff to review, a failed run — lands in one inbox, in the panel and in the Android/iOS client, with push notifications you can tune per project.',
  },
  {
    title: 'Limit-aware queue',
    text: 'Usage limits belong to accounts, so the queue knows them. A run that hits a limit is deferred until the window resets instead of failing, and a logged-out worker says so out loud.',
  },
  {
    title: 'Projects & roles',
    text: 'Members, role ladders and per-project access. One deployment can host many projects and teams that never see each other’s tasks.',
  },
  {
    title: 'Tool API',
    text: 'Every read and every action is also a tool on the /mcp endpoint, so scripts, CI and other agents can drive Agentiz as easily as a person in the panel.',
  },
  {
    title: 'Self-hosted',
    text: 'One Node.js server, SQLite out of the box or PostgreSQL in production. Your tasks, code and logs stay on your infrastructure.',
  },
];

const SHOTS: Array<{ src: string; alt: string; caption: string }> = [
  { src: runsShot, alt: 'List of runs across all projects', caption: 'Runs across every project: status, pipeline, worker and duration at a glance.' },
  { src: runShot, alt: 'A single run with its stages', caption: 'One run: which pipeline and worker took it, every stage, and what the agent did.' },
  { src: runLogShot, alt: 'Run log', caption: 'The run log, streamed from the worker while the agent works.' },
  { src: inboxShot, alt: 'Inbox with a failed run', caption: 'The inbox: what is waiting on you, why, and the button that resolves it.' },
  { src: pipelineShot, alt: 'Pipeline editor, stages tab', caption: 'The pipeline editor: stages, agents, source, hooks and notifications.' },
];

const FLOW = ['task', 'pipeline', 'worker', 'agent stages', 'review', 'commit / PR'];

export default function Home(props: { docs: DocLink[] }) {
  const docs = props.docs.filter((doc) => doc.slug !== 'index');

  return (
    <Layout
      section="home"
      description="Agentiz is a self-hosted server that turns tasks from your tracker into pipelines of coding agents running on your own workers, with a human reviewing every change."
    >
      <main>
        <div className="wrap hero">
          <h1>Coding agents, on&nbsp;your machines, under review.</h1>
          <p>
            Agentiz is a self-hosted server that takes tasks from your tracker, runs them through
            pipelines of AI coding agents on workers you own, and puts every change in front of a
            person before it lands.
          </p>
          <div className="buttons">
            <a className="btn solid" href="/docs/getting-started">Get started</a>
            <a className="btn" href={GITHUB}>View on GitHub</a>
          </div>
          <pre className="install"><code>{`git clone --recurse-submodules ${GITHUB}
cd agentiz && npm install && npm run dev
# → http://localhost:17280/dashboard`}</code></pre>
        </div>

        <section>
          <div className="wrap">
            <h2>How it works</h2>
            <p className="flow">
              {FLOW.map((step, index) => (
                <span key={step} style={{ display: 'contents' }}>
                  {index > 0 ? <b>→</b> : null}
                  <span>{step}</span>
                </span>
              ))}
            </p>
            <p>
              A task arrives from GitHub, GitLab, the panel or the phone. Agentiz picks the pipeline
              that matches it, freezes everything the run needs into a job and queues it. A worker —
              a small Python process on a machine you control — claims the job, prepares the code
              and runs each stage with the agent its role names (Claude Code, Codex or anything else
              that speaks the Agent Client Protocol). The result comes back as a diff, a branch or a
              pull request, and a human decides what happens to it.
            </p>
          </div>
        </section>

        <section>
          <div className="wrap">
            <h2>What’s inside</h2>
            <div className="grid">
              {FEATURES.map((feature) => (
                <div key={feature.title}>
                  <h3>{feature.title}</h3>
                  <p>{feature.text}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section id="screenshots">
          <div className="wrap">
            <h2>Screenshots</h2>
            <p className="note">
              The panel’s interface is in Russian for now. Click a picture to open it in full size
              and colour.
            </p>

            {SHOTS.map((shot, index) => (
              <figure className="shot" key={shot.src}>
                <a href={shot.src}>
                  <img src={shot.src} alt={shot.alt} loading="lazy" width={1920} height={1200} />
                </a>
                <figcaption><b>{String(index + 1).padStart(2, '0')}</b>{shot.caption}</figcaption>
              </figure>
            ))}

            <figure className="shot">
              <div className="phones">
                <a href={mobileTasksShot}>
                  <img src={mobileTasksShot} alt="Mobile app: project tasks" loading="lazy" width={412} height={915} />
                </a>
                <a href={mobileRunShot}>
                  <img src={mobileRunShot} alt="Mobile app: run details" loading="lazy" width={412} height={915} />
                </a>
              </div>
              <figcaption>
                <b>{String(SHOTS.length + 1).padStart(2, '0')}</b>
                The mobile client: start a task, follow the run, answer the agent.
              </figcaption>
            </figure>
          </div>
        </section>

        <section>
          <div className="wrap">
            <h2>Documentation</h2>
            <div className="grid">
              {docs.map((doc) => (
                <div key={doc.slug}>
                  <h3><a href={`/docs/${doc.slug}`}>{doc.title}</a></h3>
                  <p>{doc.description}</p>
                </div>
              ))}
            </div>
          </div>
        </section>
      </main>
    </Layout>
  );
}
