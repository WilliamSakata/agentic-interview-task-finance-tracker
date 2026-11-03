import {
  HeadContent,
  Scripts,
  createRootRoute,
  Outlet,
  Link,
} from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { useState, useCallback, lazy, Suspense } from "react";

const Sidebar = lazy(() =>
  import("../components/sidebar").then((m) => ({ default: m.Sidebar })),
);

import { getLocale } from "#/paraglide/runtime";
import { BudgetAlertBar } from "#/components/budget-alert-bar";
import { m } from "#/paraglide/messages";

import appCss from "../styles.css?url";
import { useServerFn } from "@tanstack/react-start";
import {
  getSession,
  hasUsers,
  logoutEverywhere,
  resendVerification,
} from "#/server/auth.functions";


export type SessionUser = {
  userId: string;
  username: string;
  email: string | null;
  emailVerified: boolean;
};

const getAuthState = createServerFn({ method: "GET" }).handler(
  async (): Promise<{
    user: SessionUser | null;
    hasUsers: boolean;
  }> => {
    const user = await getSession();
    if (user) {
      return { user, hasUsers: true };
    }
    const usersExist = await hasUsers();
    return { user: null, hasUsers: usersExist };
  },
);

export const Route = createRootRoute({
  beforeLoad: async (): Promise<{
    user: SessionUser | null;
    hasUsers: boolean;
  }> => {
    const result = await getAuthState();

    return {
      user: result.user,
      hasUsers: result.hasUsers,
    };
  },

  head: () => ({
    meta: [
      {
        charSet: "utf-8",
      },
      {
        name: "viewport",
        content: "width=device-width, initial-scale=1",
      },
      {
        title: m.page_title(),
      },
    ],
    links: [
      {
        rel: "stylesheet",
        href: appCss,
      },
    ],
  }),
  component: RootDocument,
});

function LogoutEverywhereButton() {
  const doLogoutEverywhere = useServerFn(logoutEverywhere);
  const [loading, setLoading] = useState(false);

  return (
    <button
      onClick={async () => {
        setLoading(true);
        try {
          await doLogoutEverywhere();
        } catch {
          // redirect to /login happens automatically
        } finally {
          setLoading(false);
        }
      }}
      disabled={loading}
      title={m.logout_everywhere_desc()}
      className="h-9 px-4 flex items-center justify-center text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors rounded-md disabled:opacity-50"
    >
      {m.logout_everywhere()}
    </button>
  );
}

function VerifyEmailBanner() {
  const doResend = useServerFn(resendVerification);
  const [resent, setResent] = useState(false);
  const [loading, setLoading] = useState(false);

  return (
    <div
      role="status"
      className="bg-amber-100 dark:bg-amber-950 text-amber-900 dark:text-amber-100 border-b border-amber-300 dark:border-amber-800"
    >
      <div className="page-wrap py-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
        <span>{resent ? m.verify_banner_resent() : m.verify_banner_text()}</span>
        {!resent && (
          <button
            onClick={async () => {
              setLoading(true);
              try {
                const result = await doResend();
                if (!result || !("error" in result)) {
                  setResent(true);
                }
              } finally {
                setLoading(false);
              }
            }}
            disabled={loading}
            className="font-medium underline underline-offset-4 hover:no-underline disabled:opacity-50"
          >
            {m.verify_banner_resend()}
          </button>
        )}
      </div>
    </div>
  );
}

function RootDocument() {
  const { user } = Route.useRouteContext();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const handleSidebarToggle = useCallback(() => {
    setSidebarOpen((prev) => !prev);
  }, []);

  const handleSidebarClose = useCallback(() => {
    setSidebarOpen(false);
  }, []);

  return (
    <html lang={getLocale()}>
      <head>
        <HeadContent />
      </head>
      <body>
        {user ? (
          <div className="min-h-screen">
            {/* Sidebar */}
            <Suspense fallback={null}>
              <Sidebar open={sidebarOpen} onClose={handleSidebarClose} />
            </Suspense>

            {/* Main content area */}
            <div
              className={`
                transition-[margin-left] duration-200 ease-out
                lg:ml-64
              `}
            >
              {/* Top bar */}
              <div className="border-b border-line/50 bg-header-bg/80 backdrop-blur-sm sticky top-0 z-20">
                <div className="page-wrap py-3 flex items-center justify-between">
                  {/* Hamburger (mobile only) */}
                  <button
                    onClick={handleSidebarToggle}
                    className="lg:hidden h-9 w-9 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors"
                    aria-label={m.open_nav_menu()}
                  >
                    <svg
                      className="size-5"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth={2}
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5"
                      />
                    </svg>
                  </button>

                  <div className="flex items-center gap-3">
                    <span className="text-sm text-muted-foreground">
                      {user.username}
                    </span>
                    <LogoutEverywhereButton />
                    <Link
                      to="/logout"
                      className="h-9 px-4 flex items-center justify-center text-sm font-medium bg-white dark:bg-neutral-900 text-neutral-900 dark:text-neutral-50 border border-neutral-300 dark:border-neutral-700 hover:bg-neutral-50 dark:hover:bg-neutral-800 transition-colors rounded-md"
                    >
                      {m.sign_out_link()}
                    </Link>
                  </div>
                </div>
              </div>

              {!user.emailVerified && <VerifyEmailBanner />}
              <BudgetAlertBar />

              {/* Page content */}
              <Outlet />
            </div>
          </div>
        ) : (
          <Outlet />
        )}
        <Scripts />
      </body>
    </html>
  );
}
