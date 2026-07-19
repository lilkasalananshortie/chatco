import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  const routeGroups: Record<string, string[]> = {
    admin: [
      "/admin-dashboard",
      "/users",
      "/remittance",
      "/monitoring",
      "/vehicles",
      "/lost-found",
      "/analytics",
      "/settings",
      // The /announcements page lives in the (admin) route group and is only
      // linked from the admin notification bell. Commuters read announcements
      // via a hook on their rewards page, not this route — so it must be
      // ADMIN-guarded, otherwise admins get bounced to /login.
      "/announcements",
    ],
    commuter: [
      "/dashboard",
      "/lost-and-found",
      "/rewards",
      "/feedback",
      "/profile",
      "/gcash/return",
    ],
    conductor: [
      "/unit-verification",
      "/conductor-dashboard",
    ],
  };

  let matchedGroup: string | null = null;

  for (const [group, routes] of Object.entries(routeGroups)) {
    const isMatch = routes.some(
      (route) => pathname === route || pathname.startsWith(route + "/")
    );
    if (isMatch) {
      matchedGroup = group;
      break;
    }
  }

  if (!matchedGroup) {
    return NextResponse.next();
  }

  // Check for session cookie
  const sessionToken = request.cookies.get("chatco_session")?.value;

  if (!sessionToken) {
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("redirect", pathname);
    return NextResponse.redirect(loginUrl);
  }

  // Read role from the chatco_role cookie
  const userRole = request.cookies.get("chatco_role")?.value || "";

  if (matchedGroup === "admin" && userRole !== "ADMIN") {
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("redirect", pathname);
    return NextResponse.redirect(loginUrl);
  }

  if (matchedGroup === "commuter" && userRole !== "COMMUTER") {
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("redirect", pathname);
    return NextResponse.redirect(loginUrl);
  }

  if (matchedGroup === "conductor" && userRole !== "CONDUCTOR") {
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("redirect", pathname);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    "/admin-dashboard/:path*",
    "/users/:path*",
    "/remittance/:path*",
    "/monitoring/:path*",
    "/vehicles/:path*",
    "/lost-found/:path*",
    "/analytics/:path*",
    "/settings/:path*",
    "/dashboard/:path*",
    "/lost-and-found/:path*",
    "/rewards/:path*",
    "/feedback/:path*",
    "/profile/:path*",
    "/announcements/:path*",
    "/unit-verification/:path*",
    "/conductor-dashboard/:path*",
    "/gcash/return/:path*",
  ],
};