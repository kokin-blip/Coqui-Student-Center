import { expect,test } from "vitest";
import { completionInstants,timezoneLabel } from "../src/features/student/completionTime";
test("completion time uses the saved timezone rather than the computer timezone",()=>{expect(completionInstants("2026-09-28","18:00","America/Phoenix")).toEqual(["2026-09-29T01:00:00.000Z"]);expect(timezoneLabel("America/Phoenix")).toContain("America/Phoenix");});
test("DST gaps and folds require an explicit valid occurrence",()=>{expect(completionInstants("2026-03-08","02:30","America/New_York")).toEqual([]);expect(completionInstants("2026-11-01","01:30","America/New_York")).toEqual(["2026-11-01T05:30:00.000Z","2026-11-01T06:30:00.000Z"]);expect(completionInstants("2026-02-30","18:00","America/Phoenix")).toEqual([]);});
