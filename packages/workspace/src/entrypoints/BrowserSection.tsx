import { useQuery } from '@spyria/db/react'
import {
  type BrowserSettings,
  browserAddressOf,
  browserSignInHours,
  isBrowserAddress,
  type WorkspaceId,
} from '@spyria/kernel'
import {
  buttonClass,
  ErrorMessage,
  fieldClass,
  LabelledSection,
  labelClass,
  rowListClass,
  SettingRow,
  Switch,
  useGuardedAction,
} from '@spyria/ui'
import { useEffect, useState } from 'react'
import { browserSettingsOf } from '../queries/get-browser-settings.ts'
import { useWorkspaceCommands } from './providers.tsx'

type AddressList = 'allowedInternalAddresses' | 'allowedSites' | 'blockedSites'
type Switches = {
  [Name in keyof BrowserSettings]: BrowserSettings[Name] extends boolean ? Name : never
}[keyof BrowserSettings]
type Draft = Omit<BrowserSettings, AddressList | 'signInHours'> & Record<AddressList, string> & { signInHours: string }

const draftOf = (settings: BrowserSettings): Draft => ({
  ...settings,
  allowedInternalAddresses: settings.allowedInternalAddresses.join('\n'),
  allowedSites: settings.allowedSites.join('\n'),
  blockedSites: settings.blockedSites.join('\n'),
  signInHours: settings.signInHours === null ? '' : String(settings.signInHours),
})
const addressesOf = (text: string) => [
  ...new Set(
    text
      .split(/[\n,]+/)
      .map(browserAddressOf)
      .filter(Boolean),
  ),
]
const settingsOf = (draft: Draft): BrowserSettings => ({
  ...draft,
  allowedInternalAddresses: addressesOf(draft.allowedInternalAddresses),
  allowedSites: addressesOf(draft.allowedSites),
  blockedSites: addressesOf(draft.blockedSites),
  signInHours: draft.signInHours.trim() === '' ? null : Math.trunc(Number(draft.signInHours)),
})
const invalidAddressOf = (settings: BrowserSettings) =>
  [...settings.allowedInternalAddresses, ...settings.allowedSites, ...settings.blockedSites].find(
    (address) => !isBrowserAddress(address),
  )

const switchRows: readonly { name: Switches; title: string; description: string }[] = [
  {
    name: 'forAgents',
    title: 'Agents use a browser',
    description: 'Agents open pages, read them and act on them in the browser of the member who prompted',
  },
  {
    name: 'forMembers',
    title: 'Members browse',
    description: 'Members type addresses, click and type in their own browser in the Browser tab',
  },
  {
    name: 'approveSubmits',
    title: 'Ask before the agent submits',
    description:
      'The member approves each form the agent submits and each script it runs in their browser; reading needs no approval',
  },
  {
    name: 'blockInternalNetworks',
    title: 'Block internal networks',
    description:
      "Pages cannot reach the host machine or private addresses, except the ones allowed below; the chat's own runtime stays reachable as localhost",
  },
  { name: 'downloads', title: 'Downloads', description: "Files a page downloads go to the member's computer" },
  { name: 'uploads', title: 'Uploads', description: 'Members can pick files from their computer for a page' },
  {
    name: 'recordVisits',
    title: 'Record visited addresses',
    description: 'Each address a browser visits goes to the audit log with its chat, never the page contents',
  },
]

const AddressField = ({
  label,
  hint,
  value,
  onChange,
}: {
  label: string
  hint: string
  value: string
  onChange: (value: string) => void
}) => (
  <label className={labelClass}>
    {label}
    <textarea
      rows={3}
      placeholder="One per line"
      className={`${fieldClass} font-mono`}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
    <span className="text-xs">{hint}</span>
  </label>
)

export const BrowserSection = ({ workspaceId }: { workspaceId: WorkspaceId }) => {
  const commands = useWorkspaceCommands()
  const stored = useQuery(browserSettingsOf, workspaceId)
  const [draft, setDraft] = useState(() => draftOf(stored))
  const [isDirty, setIsDirty] = useState(false)
  const [isSaved, setIsSaved] = useState(false)
  const [invalidAddress, setInvalidAddress] = useState<string>()
  const { errorMessage, isPending, run } = useGuardedAction()
  useEffect(() => {
    if (!isDirty) setDraft(draftOf(stored))
  }, [stored, isDirty])
  const edit = (change: Partial<Draft>) => {
    setDraft((current) => ({ ...current, ...change }))
    setIsDirty(true)
    setIsSaved(false)
    setInvalidAddress(undefined)
  }
  const save = () => {
    const settings = settingsOf(draft)
    const invalid = invalidAddressOf(settings)
    if (invalid) return setInvalidAddress(invalid)
    return run(async () => {
      await commands.setBrowserSettings({ workspaceId, settings })
      setIsSaved(true)
      setIsDirty(false)
    })
  }
  return (
    <LabelledSection title="Browser">
      <p className="-mt-2 text-sm text-muted">
        Each member gets their own browser in each AI chat, next to the chat's runtime, with their own sign-ins. Only
        they watch it; others see the agent's steps.
      </p>
      <form
        className="flex flex-col gap-6"
        onSubmit={(event) => {
          event.preventDefault()
          save()
        }}
      >
        <div className={rowListClass}>
          {switchRows.map(({ name, title, description }) => (
            <SettingRow key={name} title={title} description={description}>
              <Switch label={title} isOn={draft[name]} onToggle={() => edit({ [name]: !draft[name] })} />
            </SettingRow>
          ))}
        </div>
        {draft.blockInternalNetworks && (
          <AddressField
            label="Internal addresses allowed"
            hint="Host names or IP addresses, such as staging.internal"
            value={draft.allowedInternalAddresses}
            onChange={(value) => edit({ allowedInternalAddresses: value })}
          />
        )}
        <AddressField
          label="Sites allowed"
          hint="Leave empty to allow every site. A site includes its subdomains."
          value={draft.allowedSites}
          onChange={(value) => edit({ allowedSites: value })}
        />
        <AddressField
          label="Sites blocked"
          hint="A site includes its subdomains"
          value={draft.blockedSites}
          onChange={(value) => edit({ blockedSites: value })}
        />
        <label className={labelClass}>
          Sign-ins last at most, in hours
          <input
            type="number"
            min={browserSignInHours.minimum}
            max={browserSignInHours.maximum}
            placeholder="As long as the chat's runtime"
            className={`${fieldClass} w-64`}
            value={draft.signInHours}
            onChange={(event) => edit({ signInHours: event.target.value })}
          />
          <span className="text-xs">
            A member's browser keeps its sign-ins until the chat's runtime stops, or for this long if it is shorter
          </span>
        </label>
        <div className="flex items-center gap-3">
          <button type="submit" className={buttonClass} disabled={isPending}>
            Save
          </button>
          {isSaved && <span className="text-sm text-muted">Saved</span>}
        </div>
        {invalidAddress && <ErrorMessage message={`${invalidAddress} is not a host name or an IP address`} />}
      </form>
      <ErrorMessage message={errorMessage} />
    </LabelledSection>
  )
}
