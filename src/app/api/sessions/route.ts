import { NextResponse } from "next/server";
import { getRepository } from "@/lib/db/repository";

export async function POST() {
  try {
    const repo = getRepository();
    const { session, resumeToken } = await repo.createSession({
      phase: "speak",
      promptVersion: "v1.0",
    });

    return NextResponse.json(
      {
        sessionId: session.id,
        resumeToken,
        phase: session.phase,
      },
      { status: 201 }
    );
  } catch (error) {
    console.error("Session creation error:", error);
    return NextResponse.json(
      {
        error: "セッションの作成に失敗しました。",
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}
