import { FormEvent, useState } from "react";
import { SlidersHorizontalIcon } from "lucide-react";

import { setToken } from "@/api";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

export default function TokenGate({ onReady }: { onReady: () => void }) {
  const [value, setValue] = useState("");

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!value.trim()) return;
    setToken(value.trim());
    onReady();
  };

  return (
    <div className="flex min-h-svh items-center justify-center bg-background p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <div className="flex size-9 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <SlidersHorizontalIcon className="size-4" />
          </div>
          <CardTitle>Signal</CardTitle>
          <CardDescription>Enter the admin token to continue.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="flex flex-col gap-6">
            <Field>
              <FieldLabel htmlFor="token-gate-token">Admin token</FieldLabel>
              <Input
                id="token-gate-token"
                type="password"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder="admin token"
                autoFocus
              />
              <FieldDescription>Stored in this browser only.</FieldDescription>
            </Field>
            <Button type="submit">Continue</Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
