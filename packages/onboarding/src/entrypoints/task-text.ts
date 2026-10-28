import type { OnboardingTask } from '../domain/tasks.ts'

type TaskText = Readonly<{ title: string; explanation: string; page: string; section?: string }>

export const blockedExplanation = 'Verify your domain first.'

export const taskTextOf = (task: OnboardingTask, domain: string | undefined): TaskText => {
  switch (task) {
    case 'verify-domain':
      return {
        title: 'Verify your email domain',
        explanation: `Proves your organization owns ${domain ? `@${domain}` : 'its email domain'}. Until it's verified, you can't invite anyone.`,
        page: 'settings/sso',
      }
    case 'connect-github-app':
      return {
        title: 'Connect the GitHub App',
        explanation:
          'Lets agents read your repositories and open pull requests from dev chats. You choose on GitHub which repositories it can see.',
        page: 'settings/github',
      }
    case 'connect-runtime':
      return {
        title: 'Connect a runtime',
        explanation:
          'Agents work in isolated containers on a machine you run. Add one so members can start agent chats.',
        page: 'settings/runtime',
      }
    case 'add-ai-key':
      return {
        title: 'Add your AI key',
        explanation:
          "Spyria doesn't sell AI usage: each member brings their own key (Anthropic, OpenAI…), and their prompts are billed to it. Only using Claude Code or Codex on your own machine? You can skip this.",
        page: 'profile',
        section: 'llm-access',
      }
    case 'invite-members':
      return {
        title: 'Invite members',
        explanation:
          'Add teammates by work email; they get in the next time they sign in. No email is sent, so let them know.',
        page: 'settings/team',
      }
    case 'link-github-account':
      return {
        title: 'Link your GitHub account',
        explanation: 'So the pushes and pull requests you make from Spyria show you as the author.',
        page: 'profile',
        section: 'connections',
      }
    case 'add-profile-picture':
      return {
        title: 'Add a profile picture',
        explanation: 'Helps teammates tell who wrote what in shared chats.',
        page: 'profile',
        section: 'profile-picture',
      }
  }
}
