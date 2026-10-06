import { redirect } from "next/navigation";
import { signedIn, authRequired } from "@/lib/session";
import NewListingForm from "@/components/NewListingForm";

export const dynamic = "force-dynamic";

export default async function NewListing() {
  if (authRequired() && !(await signedIn())) redirect("/sign-in");
  return <NewListingForm />;
}
