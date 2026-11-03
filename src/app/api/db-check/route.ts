import { NextResponse } from "next/server";

export async function GET() {
  const supabaseUrl =
    process.env.SUPABASE_URL ||
    process.env.NEXT_PUBLIC_SUPABASE_URL;

  const supabaseKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_ANON_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
    process.env.SUPABASE_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_KEY;

  if (!supabaseUrl) {
    return NextResponse.json({
      status: "missing_url",
      message: "SUPABASE_URL 環境変数が設定されていません。",
    });
  }

  // ホスト名だけ抽出（安全のためキーやパスは出さない）
  let hostname = "";
  try {
    const parsed = new URL(supabaseUrl.trim());
    hostname = parsed.hostname;
  } catch {
    return NextResponse.json({
      status: "invalid_url_format",
      message: `SUPABASE_URL の形式が正しくありません (値の長さ: ${supabaseUrl.length})`,
    });
  }

  try {
    const testUrl = `${supabaseUrl.trim().replace(/\/+$/, "")}/rest/v1/`;
    const res = await fetch(testUrl, {
      method: "GET",
      headers: {
        apikey: supabaseKey ? supabaseKey.trim() : "",
      },
    });

    return NextResponse.json({
      status: "connected",
      hostname,
      hasKey: Boolean(supabaseKey),
      httpStatus: res.status,
      httpStatusText: res.statusText,
    });
  } catch (err) {
    return NextResponse.json({
      status: "connection_error",
      hostname,
      hasKey: Boolean(supabaseKey),
      errorName: err instanceof Error ? err.name : "Unknown",
      errorMessage: err instanceof Error ? err.message : String(err),
      cause: (err as { cause?: unknown })?.cause
        ? String((err as { cause?: unknown }).cause)
        : null,
    });
  }
}
