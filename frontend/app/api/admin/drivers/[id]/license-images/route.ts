import { NextRequest } from "next/server";
import { jsonError, jsonData, jsonValidationError } from "@/lib/conductor/server/response";
import { proxyToLaravel } from "@/lib/conductor/server/proxy";

/** POST /api/admin/drivers/{id}/license-images (multipart/form-data). */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (!id || id === "undefined") return jsonError("Driver ID is missing.", 400);

  let body: FormData;
  try {
    body = await request.formData();
  } catch {
    return jsonError("Invalid multipart request.", 400);
  }

  const result = await proxyToLaravel(request, `/admin/drivers/${id}/license-images`, {
    method: "POST",
    body,
  });

  if (!result.ok) {
    if (result.status === 422) {
      return jsonValidationError(result.message ?? "Validation failed.", result.errors, 422);
    }
    return jsonError(result.message ?? "Failed to upload license image(s).", result.status);
  }
  return jsonData(result.data);
}
