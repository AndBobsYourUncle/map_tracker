import { NextResponse, type NextRequest } from "next/server";
import { createProfile, listProfiles } from "@/lib/profileStore";

// Profile registry for multi-device sync.
//   GET           -> { profiles: [{ id, name, createdAt }] }
//   POST { name } -> creates a profile, returns { id, name, createdAt }
// Open on the LAN (no auth, per project decision).

// The registry changes at runtime, so never cache this.
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ profiles: await listProfiles() });
}

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const name =
    typeof (body as { name?: unknown })?.name === "string"
      ? (body as { name: string }).name.trim()
      : "";
  if (!name) {
    return NextResponse.json({ error: "Profile name is required" }, { status: 400 });
  }

  const profile = await createProfile(name);
  return NextResponse.json(profile, { status: 201 });
}
