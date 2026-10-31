export const Switch = ({ label, isOn, onToggle }: { label: string; isOn: boolean; onToggle: () => void }) => (
  <label className="flex w-fit items-center gap-3 text-sm">
    <button
      type="button"
      role="switch"
      aria-checked={isOn}
      aria-label={label}
      onClick={onToggle}
      className={`h-5 w-9 shrink-0 rounded-full p-0.5 ${isOn ? 'bg-accent' : 'bg-line'}`}
    >
      <span className={`block size-4 rounded-full bg-raised transition ${isOn ? 'translate-x-4' : ''}`} />
    </button>
    {label}
  </label>
)
