export function Toggle({ checked, onChange, disabled }: { checked: boolean; onChange: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      className={`toggle${checked ? " on" : ""}`}
      onClick={onChange}
    >
      <span className="toggle-knob" />
    </button>
  );
}
