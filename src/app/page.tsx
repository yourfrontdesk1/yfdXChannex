import { redirect } from "next/navigation";
import { signedIn, authRequired } from "@/lib/session";
import Link from "next/link";
import { db } from "@/lib/db";
import type { Account, Property } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function Home() {
  if (authRequired() && !(await signedIn())) redirect("/sign-in");

  let accounts: Account[] = [];
  let properties: Property[] = [];
  let error: string | null = null;

  try {
    const supabase = db();
    const [a, p] = await Promise.all([
      supabase.from("accounts").select("*").order("name"),
      supabase.from("properties").select("*").order("name"),
    ]);
    if (a.error) throw a.error;
    if (p.error) throw p.error;
    accounts = (a.data ?? []) as Account[];
    properties = (p.data ?? []) as Property[];
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  return (
    <>
      <h1>Properties</h1>
      <p className="lede">
        Every property below is owned by this service. Rates, availability and
        restrictions are set here and pushed to Channex on the change itself,
        never on a timer.
      </p>

      {error ? (
        <div className="card">
          <h2>Not connected to the database yet</h2>
          <p className="lede">
            Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, then run the schema in
            db/001_schema.sql.
          </p>
          <p className="legend">{error}</p>
        </div>
      ) : properties.length === 0 ? (
        <div className="card">
          <h2>No properties yet</h2>
          <p className="lede">
            Seed an account and its property, then the grid opens on it.
          </p>
        </div>
      ) : (
        <div className="card">
          <table className="list">
            <thead>
              <tr>
                <th>Property</th>
                <th>Account</th>
                <th>Currency</th>
                <th>Channex</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {properties.map((p) => {
                const account = accounts.find((a) => a.id === p.account_id);
                return (
                  <tr key={p.id}>
                    <td>{p.name}</td>
                    <td>{account ? account.name : "unassigned"}</td>
                    <td>{p.currency}</td>
                    <td>
                      {p.channex_property_id ? (
                        <span className="pill live">mapped</span>
                      ) : (
                        <span className="pill pending">not mapped</span>
                      )}
                    </td>
                    <td>
                      <Link href={`/grid/${p.id}`}>Open grid</Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
