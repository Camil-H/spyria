CREATE TABLE "warm_runtimes" (
	"workspace_id" text,
	"id" text,
	"repository" text NOT NULL,
	"setup_command" text NOT NULL,
	"host_id" text NOT NULL,
	"state" text NOT NULL,
	"image" text NOT NULL,
	"api_key_id" text NOT NULL,
	"base_branch" text,
	"agent_version" text,
	"agent_protocol_version" integer,
	"created_at" timestamp with time zone NOT NULL,
	"state_changed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "warm_runtimes_pkey" PRIMARY KEY("workspace_id","id"),
	CONSTRAINT "warm_runtimes_state" CHECK ("state" in ('creating', 'preparing', 'ready'))
);
--> statement-breakpoint
CREATE INDEX "warm_runtimes_workspace_id_repository_state_index" ON "warm_runtimes" ("workspace_id","repository","state");--> statement-breakpoint
CREATE INDEX "warm_runtimes_workspace_id_host_id_index" ON "warm_runtimes" ("workspace_id","host_id");--> statement-breakpoint
ALTER TABLE "warm_runtimes" ADD CONSTRAINT "warm_runtimes_0CeFw1k8ZToX_fkey" FOREIGN KEY ("workspace_id","host_id") REFERENCES "runtime_hosts"("workspace_id","id");