-- The playbook is a real book by a named author, so the model carries one.
ALTER TABLE "Playbook" ADD COLUMN "author" TEXT;
