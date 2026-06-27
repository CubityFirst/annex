import { useLayoutEffect } from "react";
import { Routes, Route, useLocation, type Location } from "react-router-dom";
import { applyThemeToRoot, pathUsesUserTheme, DEFAULT_THEME_PREFS } from "@/lib/theme";
import { DocsLayout } from "./layouts/DocsLayout";
import { LandingPage } from "./pages/LandingPage";
import { LoginPage } from "./pages/LoginPage";
import { OAuthAuthorizePage } from "./pages/OAuthAuthorizePage";
import { RegisterPage } from "./pages/RegisterPage";
import { CheckEmailPage } from "./pages/CheckEmailPage";
import { DemoPage } from "./pages/DemoPage";
import { VerifyEmailPage } from "./pages/VerifyEmailPage";
import { DashboardPage } from "./pages/DashboardPage";
import { ProjectPage } from "./pages/ProjectPage";
import { DocPage } from "./pages/DocPage";
import { FilePage } from "./pages/FilePage";
import { NotFoundPage } from "./pages/NotFoundPage";
import { SiteSettingsPage } from "./pages/SiteSettingsPage";
import { GraphPage } from "./pages/GraphPage";
import { UserSettingsPage } from "./pages/UserSettingsPage";
import { UserProfilePage } from "./pages/UserProfilePage";
import { PublicDocPage } from "./pages/PublicDocPage";
import { AcceptInvitePage } from "./pages/AcceptInvitePage";
import { PendingInvitesPage } from "./pages/PendingInvitesPage";
import { OrgPage } from "./pages/OrgPage";
import { OrgSettingsPage } from "./pages/OrgSettingsPage";
import { TagPage } from "./pages/TagPage";
import { PrivacyPage } from "./pages/PrivacyPage";
import { TermsPage } from "./pages/TermsPage";
import { AcknowledgementsPage } from "./pages/AcknowledgementsPage";
import { TestAudioPage } from "./pages/TestAudioPage";
import { Toaster } from "@/components/ui/sonner";

export function App() {
  const location = useLocation();
  // Background-location pattern: when a link passes `state.backgroundLocation`,
  // the main routes render that location so the previous page (sidebar, content)
  // stays mounted underneath the modal route.
  const state = location.state as { backgroundLocation?: Location } | null;
  const backgroundLocation = state?.backgroundLocation;

  // Keep the landing/auth routes on the default (dark) brand look even when a
  // user with a saved light/custom theme navigates here client-side (the theme
  // applied by DocsLayout would otherwise linger on the <html>). App routes are
  // left alone - DocsLayout owns applying the saved theme there.
  useLayoutEffect(() => {
    if (!pathUsesUserTheme(location.pathname)) {
      applyThemeToRoot(DEFAULT_THEME_PREFS);
    }
  }, [location.pathname]);
  return (
    <>
      <Routes location={backgroundLocation ?? location}>
        <Route path="/" element={<LandingPage />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/oauth/authorize" element={<OAuthAuthorizePage />} />
        <Route path="/register" element={<RegisterPage />} />
        <Route path="/check-email" element={<CheckEmailPage />} />
        <Route path="/demo" element={<DemoPage />} />
        <Route path="/verify-email" element={<VerifyEmailPage />} />
        <Route element={<DocsLayout />}>
          <Route path="/dashboard" element={<DashboardPage />} />
          <Route path="/projects/:projectId" element={<ProjectPage />} />
          <Route path="/projects/:projectId/folders/:folderId" element={<ProjectPage />} />
          <Route path="/projects/:projectId/docs/:docId" element={<DocPage />} />
          <Route path="/projects/:projectId/files/:fileId" element={<FilePage />} />
          <Route path="/projects/:projectId/settings" element={<SiteSettingsPage />} />
          <Route path="/projects/:projectId/graph" element={<GraphPage />} />
          <Route path="/projects/:projectId/tags/:tag" element={<TagPage />} />
          <Route path="/settings" element={<UserSettingsPage />} />
          <Route path="/u/:userId" element={<UserProfilePage />} />
          <Route path="/invites/pending" element={<PendingInvitesPage />} />
          <Route path="/orgs/:orgId" element={<OrgPage />} />
          <Route path="/orgs/:orgId/settings" element={<OrgSettingsPage />} />
        </Route>
        <Route path="/privacy" element={<PrivacyPage />} />
        <Route path="/terms" element={<TermsPage />} />
        <Route path="/acknowledgements" element={<AcknowledgementsPage />} />
        <Route path="/test/audio" element={<TestAudioPage />} />
        <Route path="/invite/:token" element={<AcceptInvitePage />} />
        <Route path="/s/:projectId" element={<PublicDocPage />} />
        <Route path="/s/:projectId/:docId" element={<PublicDocPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
      {backgroundLocation && (
        <Routes>
          <Route path="/u/:userId" element={<UserProfilePage />} />
        </Routes>
      )}
      <Toaster />
    </>
  );
}
