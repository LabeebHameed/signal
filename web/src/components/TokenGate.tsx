import { FormEvent, useState } from "react";
import { setToken } from "../api";

export default function TokenGate({ onReady }: { onReady: () => void }) {
  const [value, setValue] = useState("");

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!value.trim()) return;
    setToken(value.trim());
    onReady();
  };

  return (
    <div className="token-gate">
      <div className="token-gate-card">
        <div className="brand">
          <span className="brand-mark">S</span>
          <span className="brand-name">Signal</span>
        </div>
        <p>Enter the admin token to continue.</p>
        <form onSubmit={submit}>
          <input
            type="password"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="admin token"
            autoFocus
          />
          <button type="submit">Continue</button>
        </form>
      </div>
    </div>
  );
}
