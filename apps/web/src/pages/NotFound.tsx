import { Link } from "react-router-dom";
import { Button, Logo } from "../components/ui";

export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-slate-50 dark:bg-slate-950">
      <Logo className="text-lg text-slate-900 dark:text-white" />
      <h1 className="text-3xl font-semibold text-slate-900 dark:text-white">404</h1>
      <p className="text-sm text-slate-500">This page does not exist.</p>
      <Link to="/">
        <Button variant="secondary">Back to home</Button>
      </Link>
    </div>
  );
}
