import { UserRound } from "lucide-react";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useSetup } from "@/lib/use-setup";

function ProfileForm({ userName }: { userName: string }) {
  const [name, setName] = useState(userName);
  const changed = name.trim() !== userName;
  const save = (e: FormEvent) => {
    e.preventDefault();
    window.electron.setup.setUserName(name);
    toast.success(name.trim() ? "Name saved" : "Name cleared");
  };

  return (
    <form onSubmit={save} className="flex max-w-md items-end gap-2">
      <div className="flex-1 space-y-2">
        <Label htmlFor="user-name">Name</Label>
        <Input id="user-name" autoComplete="name" maxLength={100} value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name" />
      </div>
      <Button type="submit" disabled={!changed}>
        Save
      </Button>
    </form>
  );
}

/** The local profile: just the name that stands in for "You". It never leaves this Mac. */
export function ProfilePage() {
  const view = useSetup();
  return (
    <section aria-labelledby="profile-heading" className="space-y-5">
      <header className="space-y-1">
        <h1 id="profile-heading" className="flex items-center gap-2.5 text-xl font-semibold tracking-tight">
          <UserRound className="size-5 text-muted-foreground" aria-hidden />
          Profile
        </h1>
        <p className="text-sm text-muted-foreground">
          Shown in place of &ldquo;You&rdquo; in transcripts, summaries and exports, in every Meeting. It is kept on this Mac only.
        </p>
      </header>
      {/* Keyed on the saved name so the field follows a change made elsewhere. */}
      {view && <ProfileForm key={view.userName} userName={view.userName} />}
    </section>
  );
}
