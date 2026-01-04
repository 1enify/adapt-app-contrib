import { For, Show, createEffect, createMemo, createSignal } from "solid-js";
import { useParams } from "@solidjs/router";
import Fuse from "fuse.js";
import { getApi } from "../../../api/Api";
import { displayName, humanizeTimeDelta } from "../../../utils";
import type { Invite } from "../../../types/guild";
import Header from "../../../components/ui/Header";
import Icon from "../../../components/icons/Icon";
import MagnifyingGlass from "../../../components/icons/svg/MagnifyingGlass";
import Xmark from "../../../components/icons/svg/Xmark";
import Funnel from "../../../components/icons/svg/Funnel";
import ChevronDown from "../../../components/icons/svg/ChevronDown";
import Clipboard from "../../../components/icons/svg/Clipboard";
import Trash from "../../../components/icons/svg/Trash";
import tooltip from "../../../directives/tooltip";
import { toast } from "solid-toast";
void tooltip;

function formatDate(value: string) {
  const dt = new Date(value);
  return dt.toLocaleString();
}

function formatAgo(value: string) {
  return humanizeTimeDelta(Date.now() - new Date(value).getTime()) + " ago";
}

function getExpiry(createdAt: string, maxAge: number) {
  if (!maxAge) return { label: "Never", full: "Never" };
  const expiresAt = new Date(new Date(createdAt).getTime() + maxAge * 1000);
  return {
    label: humanizeTimeDelta(Date.now() - expiresAt.getTime()) + " left",
    full: expiresAt.toLocaleString(),
  };
}

export default function InviteSettings() {
  const api = getApi()!;
  const cache = api.cache!;
  const params = useParams();
  const guildId = createMemo(() => BigInt(params.guildId as any));

  const [loading, setLoading] = createSignal(false);
  const [invites, setInvites] = createSignal<Invite[]>([]);
  const [query, setQuery] = createSignal("");
  const [inviterFilter, setInviterFilter] = createSignal<string>("all");

  type SortKey = "code" | "created" | "expiry" | "uses";
  const [sortKey, setSortKey] = createSignal<SortKey>("created");
  const [sortDir, setSortDir] = createSignal<"asc" | "desc">("desc");

  const fetchInvites = async () => {
    setLoading(true);
    const resp = await api.request<Invite[]>("GET", `/guilds/${guildId()}/invites`);
    if (resp.ok) {
      setInvites(resp.jsonOrThrow());
    } else {
      toast.error(resp.errorJsonOrThrow().message ?? "Failed to fetch invites");
    }
    setLoading(false);
  };

  createEffect(() => {
    void guildId();
    void fetchInvites();
  });

  const fuseIndex = createMemo(
    () =>
      new Fuse(invites(), {
        keys: ["code"],
        threshold: 0.2,
      })
  );

  const inviterOptions = createMemo(() => {
    const ids = new Set(invites().map((invite) => invite.inviter_id.toString()));
    const list = [...ids].map((id) => {
      const user = cache.users.get(BigInt(id));
      return {
        id,
        name: user ? displayName(user) : `Unknown (${id})`,
        avatar: user ? cache.avatarOf(BigInt(id)) : undefined,
      };
    });
    return list.sort((a, b) => a.name.localeCompare(b.name));
  });

  const filteredInvites = createMemo(() => {
    const base = query() ? fuseIndex().search(query()).map((r) => r.item) : invites();
    if (inviterFilter() === "all") return base;
    return base.filter((invite) => invite.inviter_id.toString() === inviterFilter());
  });

  const sortedInvites = createMemo(() => {
    const dir = sortDir() === "asc" ? 1 : -1;
    const key = sortKey();
    const list = [...filteredInvites()];
    list.sort((a, b) => {
      let va: number | string;
      let vb: number | string;
      switch (key) {
        case "code":
          va = a.code.toLowerCase();
          vb = b.code.toLowerCase();
          break;
        case "expiry":
          va = a.max_age ? new Date(a.created_at).getTime() + a.max_age * 1000 : Infinity;
          vb = b.max_age ? new Date(b.created_at).getTime() + b.max_age * 1000 : Infinity;
          break;
        case "uses":
          va = a.uses;
          vb = b.uses;
          break;
        default:
          va = new Date(a.created_at).getTime();
          vb = new Date(b.created_at).getTime();
      }
      if (va < vb) return -1 * dir;
      if (va > vb) return 1 * dir;
      return 0;
    });
    return list;
  });

  let searchRef: HTMLInputElement | null = null;

  function InviterDropdown() {
    const [open, setOpen] = createSignal(false);
    const [search, setSearch] = createSignal("");
    let ddRef: HTMLInputElement | null = null;
    const userIndex = createMemo(() => new Fuse(inviterOptions(), { keys: ["name"] }));
    const results = createMemo(() => {
      const base = [{ id: "all", name: "All inviters", avatar: undefined }, ...inviterOptions()];
      if (!search()) return base;
      const r = userIndex().search(search()).map((r) => r.item);
      return [{ id: "all", name: "All inviters", avatar: undefined }, ...r];
    });
    const listener = (event: MouseEvent) => {
      if (open() && !(event.target as Element).classList.contains("_ignore")) setOpen(false);
    };
    createEffect(() => {
      if (open()) document.addEventListener("click", listener);
      else document.removeEventListener("click", listener);
    });

    const currentName = createMemo(() => {
      if (inviterFilter() === "all") return "All inviters";
      const target = inviterOptions().find((entry) => entry.id === inviterFilter());
      return target?.name ?? "All inviters";
    });

    return (
      <div class="relative _ignore">
        <button
          class="btn btn-ghost btn-sm text-fg _ignore flex items-center gap-2"
          onClick={() => setOpen((value) => !value)}
        >
          <Icon icon={Funnel} class="w-4 h-4 fill-fg/80" />
          {currentName()}
          <Icon
            icon={ChevronDown}
            class="w-3.5 h-3.5 fill-fg/60 transition-transform"
            classList={{ "rotate-180": open(), "rotate-0": !open() }}
          />
        </button>
        <div
          class="absolute right-0 w-56 rounded-xl overflow-hidden z-[100] transition-all _ignore"
          classList={{
            "opacity-100 top-10 pointer-events-auto": open(),
            "opacity-0 top-8 pointer-events-none": !open(),
          }}
        >
          <div class="flex flex-col bg-bg-1/80 backdrop-blur _ignore">
            <div class="flex items-center _ignore bg-bg-0">
              <Icon icon={MagnifyingGlass} class="w-4 h-4 fill-fg/60 my-2 ml-2.5 _ignore" />
              <input
                ref={ddRef!}
                type="text"
                class="w-full py-2 px-2 outline-none font-medium bg-bg-0 text-sm _ignore"
                placeholder="Search users..."
                value={search()}
                onInput={(event) => setSearch(event.currentTarget.value)}
              />
              <Show when={search()}>
                <Icon
                  icon={Xmark}
                  class="w-4 h-4 fill-fg/60 mr-2 cursor-pointer _ignore"
                  onClick={() => setSearch("")}
                />
              </Show>
            </div>
            <div class="max-h-64 overflow-auto">
              <For each={results()}>
                {(entry) => (
                  <button
                    class="flex items-center p-2 gap-x-2 hover:bg-fg/10 transition text-sm truncate _ignore text-fg w-full text-left"
                    onClick={() => {
                      setInviterFilter(entry.id.toString());
                      setOpen(false);
                      setSearch("");
                    }}
                  >
                    <Show when={entry.avatar}>
                      <img src={entry.avatar} alt="" class="w-5 h-5 rounded-full" />
                    </Show>
                    {entry.name}
                  </button>
                )}
              </For>
            </div>
          </div>
        </div>
      </div>
    );
  }

  function SortDropdown() {
    const [open, setOpen] = createSignal(false);
    const options: { key: SortKey; dir: "asc" | "desc"; label: string }[] = [
      { key: "code", dir: "asc", label: "Invite code (A-Z)" },
      { key: "created", dir: "desc", label: "Created (newest first)" },
      { key: "created", dir: "asc", label: "Created (oldest first)" },
      { key: "expiry", dir: "asc", label: "Expiry (soonest first)" },
      { key: "expiry", dir: "desc", label: "Expiry (latest first)" },
      { key: "uses", dir: "desc", label: "Uses (highest first)" },
      { key: "uses", dir: "asc", label: "Uses (lowest first)" },
    ];
    const current = createMemo(
      () => options.find((opt) => opt.key === sortKey() && opt.dir === sortDir())?.label
    );
    const listener = (event: MouseEvent) => {
      if (open() && !(event.target as Element).classList.contains("_ignore")) setOpen(false);
    };
    createEffect(() => {
      if (open()) document.addEventListener("click", listener);
      else document.removeEventListener("click", listener);
    });

    return (
      <div class="relative _ignore">
        <button
          class="btn btn-ghost btn-sm text-fg _ignore flex items-center gap-2"
          onClick={() => setOpen((value) => !value)}
        >
          Sort: {current()}
          <Icon
            icon={ChevronDown}
            class="w-3.5 h-3.5 fill-fg/60 transition-transform"
            classList={{ "rotate-180": open(), "rotate-0": !open() }}
          />
        </button>
        <div
          class="absolute right-0 w-48 rounded-xl overflow-hidden z-[100] transition-all _ignore"
          classList={{
            "opacity-100 top-10 pointer-events-auto": open(),
            "opacity-0 top-8 pointer-events-none": !open(),
          }}
        >
          <div class="flex flex-col bg-bg-0/90 backdrop-blur _ignore">
            <For each={options}>
              {(opt) => (
                <button
                  class="flex items-center p-2 gap-x-2 hover:bg-fg/10 transition text-sm truncate _ignore text-fg"
                  onClick={() => {
                    setSortKey(opt.key);
                    setSortDir(opt.dir);
                    setOpen(false);
                  }}
                >
                  {opt.label}
                </button>
              )}
            </For>
          </div>
        </div>
      </div>
    );
  }

  const revokeInvite = async (code: string) => {
    const resp = await api.request("DELETE", `/guilds/${guildId()}/invites/${code}`);
    if (!resp.ok) {
      toast.error(resp.errorJsonOrThrow().message ?? "Failed to revoke invite");
      return;
    }
    setInvites((prev) => prev.filter((invite) => invite.code !== code));
  };

  const copyInvite = async (code: string) => {
    const link = `https://adapt.chat/invite/${code}`;
    await toast.promise(navigator.clipboard.writeText(link), {
      loading: "Copying invite link...",
      success: "Invite link copied!",
      error: "Failed to copy invite link.",
    });
  };

  return (
    <div class="px-4 pt-2 pb-6 text-fg">
      <Header>Invites</Header>
      <p class="mb-4 font-light text-sm text-fg/50">
        View and manage all active invites for this server.
      </p>

      <div class="flex gap-3 mb-4 mobile:flex-col">
        <div class="flex flex-grow bg-bg-0 rounded-lg items-center">
          <Icon icon={MagnifyingGlass} class="w-4 h-4 fill-fg my-2 ml-2.5 opacity-60" />
          <input
            ref={searchRef!}
            type="text"
            class="w-full text-sm p-2 outline-none font-medium bg-transparent"
            placeholder="Search invite codes..."
            value={query()}
            onInput={(event) => setQuery(event.currentTarget.value)}
          />
          <Show when={query()}>
            <Icon
              icon={Xmark}
              class="w-4 h-4 fill-fg mr-3 cursor-pointer opacity-60 hover:opacity-100 transition duration-200"
              onClick={() => {
                setQuery("");
                searchRef!.focus();
              }}
            />
          </Show>
        </div>
        <div class="flex gap-1 self-end">
          <InviterDropdown />
          <SortDropdown />
        </div>
      </div>

      <div class="flex items-center justify-between mb-2 text-fg/50 uppercase text-xs font-bold">
        <span>{sortedInvites().length} invite{sortedInvites().length === 1 ? "" : "s"}</span>
        <Show when={loading()}>
          <span>Loading...</span>
        </Show>
      </div>

      <div class="text-fg bg-bg-1/80 rounded-lg overflow-hidden">
        <div class="overflow-x-auto">
          <Show
            when={sortedInvites().length > 0}
            fallback={<div class="text-fg/60 text-sm p-3">No invites found.</div>}
          >
            <table class="w-full text-sm">
              <thead class="text-fg/60 bg-bg-0">
                <tr>
                  <th class="text-left font-semibold font-title px-3 py-2 w-40">Code</th>
                  <th class="text-left font-semibold font-title px-3 py-2 w-48">Inviter</th>
                  <th class="text-left font-semibold font-title px-3 py-2 w-40">Created</th>
                  <th class="text-left font-semibold font-title px-3 py-2 w-40">Expires</th>
                  <th class="text-left font-semibold font-title px-3 py-2 w-24">Uses</th>
                  <th class="text-right font-semibold font-title px-3 py-2 w-24" />
                </tr>
              </thead>
              <tbody>
                <For each={sortedInvites()}>
                  {(invite) => {
                    const inviter = createMemo(
                      () => cache.users.get(BigInt(invite.inviter_id)) ?? null
                    );
                    const expiry = createMemo(() => getExpiry(invite.created_at, invite.max_age));
                    return (
                      <tr class="group hover:bg-fg/10 transition">
                        <td class="px-3 py-2 font-mono">{invite.code}</td>
                        <td class="px-3 py-2">
                          <div class="flex items-center gap-2">
                            <Show when={inviter()}>
                              <img
                                src={cache.avatarOf(BigInt(invite.inviter_id))}
                                alt=""
                                class="w-6 h-6 rounded-full"
                              />
                            </Show>
                            <button
                              class="truncate text-left"
                              use:tooltip="Copy User ID"
                              onClick={() =>
                                void navigator.clipboard.writeText(invite.inviter_id.toString())
                              }
                            >
                              {inviter() ? displayName(inviter()!) : "Unknown"}
                            </button>
                          </div>
                        </td>
                        <td class="px-3 py-2 text-fg/70">
                          <span use:tooltip={formatDate(invite.created_at)}>
                            {formatAgo(invite.created_at)}
                          </span>
                        </td>
                        <td class="px-3 py-2 text-fg/70">
                          <span use:tooltip={expiry().full}>{expiry().label}</span>
                        </td>
                        <td class="px-3 py-2">
                          {invite.max_uses ? `${invite.uses}/${invite.max_uses}` : invite.uses}
                        </td>
                        <td class="px-3 py-2 text-right">
                          <div class="flex items-center justify-end gap-4">
                            <button
                              class="group/btn"
                              use:tooltip="Copy Invite Link"
                              onClick={() => void copyInvite(invite.code)}
                            >
                              <Icon icon={Clipboard} class="w-4 h-4 fill-fg/50 group-hover/btn:fill-fg/100 transition-all" />
                            </button>
                            <button
                              class="group/btn"
                              use:tooltip="Revoke Invite"
                              onClick={() => void revokeInvite(invite.code)}
                            >
                              <Icon icon={Trash} class="w-4 h-4 fill-fg/50 group-hover/btn:fill-danger transition-all" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  }}
                </For>
              </tbody>
            </table>
          </Show>
        </div>
      </div>
    </div>
  );
}
