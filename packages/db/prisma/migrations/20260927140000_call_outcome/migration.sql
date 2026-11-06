-- CreateEnum
CREATE TYPE "CallOutcome" AS ENUM ('answered', 'no_answer', 'busy', 'voicemail', 'wrong_number', 'skip');

-- AlterTable
ALTER TABLE "Call" ADD COLUMN     "outcome" "CallOutcome";

