ALTER TABLE "member_gateway_keys" ADD COLUMN "virtual_key_name" text NOT NULL DEFAULT ('vk_' || gen_random_uuid());--> statement-breakpoint
ALTER TABLE "member_gateway_keys" ALTER COLUMN "virtual_key_name" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "member_gateway_keys" ALTER COLUMN "virtual_key_id" DROP NOT NULL;
