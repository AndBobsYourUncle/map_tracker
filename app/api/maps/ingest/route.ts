import { NextResponse, type NextRequest } from "next/server";
import { getJob, startIngest } from "@/lib/ingestJobs";

// Trigger and monitor a map ingest from the UI.
//   POST { url }  -> starts a background ingest, returns { jobId, job }
//   GET           -> returns the current/last job for polling
// Open on the LAN (no auth, per project decision): this is an admin action on a
// trusted network. Note it makes outbound requests to the source site.

// Always run dynamically — the GET returns live, mutating job state.
export const dynamic = "force-dynamic";

// Validate the source URL shape: <host>/<game>/maps/<map> over http(s).
function isValidMapUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" && u.protocol !== "http:") return false;
    const segs = u.pathname.split("/").filter(Boolean);
    const i = segs.indexOf("maps");
    return i >= 1 && Boolean(segs[i + 1]);
  } catch {
    return false;
  }
}

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const url =
    typeof (body as { url?: unknown })?.url === "string"
      ? (body as { url: string }).url.trim()
      : "";

  if (!isValidMapUrl(url)) {
    return NextResponse.json(
      { error: "URL must look like https://<host>/<game>/maps/<map>" },
      { status: 400 },
    );
  }

  const { job, started } = startIngest(url);
  if (!started) {
    return NextResponse.json(
      { error: "An ingest is already running", jobId: job.id, job },
      { status: 409 },
    );
  }
  return NextResponse.json({ jobId: job.id, job }, { status: 202 });
}

export async function GET() {
  return NextResponse.json({ job: getJob() });
}
