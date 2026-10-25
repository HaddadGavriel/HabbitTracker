"""Exercise Python profile writes and the production Java planner with identical IDs."""
import base64
from importlib.resources import files
from pathlib import Path
import shutil
import subprocess
from zoneinfo import ZoneInfo

import pytest
from pydantic import ValidationError

from app.schemas import ProfileCreate, ProfileUpdate
from app.timezones import SUPPORTED_TIMEZONES

REJECTED = [
    "", " UTC", "UTC ", "utc", "america/New_York", "Mars/Olympus",
    "EST", "HST", "MST", "ROC", "Factory", "localtime", "posixrules",
    "posix/UTC", "right/UTC", "GMT+0", "GMT-0", "GMT+05:00", "UTC+05:00",
    "UT", "Z", "+05:00", "-08:00", "SystemV/EST5EDT", "../UTC", "/etc/localtime",
    "America//New_York", "UTC\n", "UTC\x00", "US/Eastern", "Asia/Calcutta", "CET",
]


@pytest.fixture(scope="module")
def native_validator(tmp_path_factory):
    if not shutil.which("javac"):
        pytest.skip("Cross-runtime contract requires JDK 17 (installed by backend CI)")
    root = Path(__file__).resolve().parents[2]
    source = root / "mobile/modules/local-reminders/android/src/main/java/com/habbittracker/reminders"
    build = tmp_path_factory.mktemp("timezone-contract")
    shutil.copy(root / "backend/app/data/timezones-v1.txt", build)
    probe = build / "TimezoneProbe.java"
    probe.write_text('''
import com.habbittracker.reminders.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
public class TimezoneProbe {
  public static void main(String[] args) throws Exception {
    var input = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
    for (String line; (line = input.readLine()) != null;) {
      String zone = new String(Base64.getDecoder().decode(line), StandardCharsets.UTF_8);
      try {
        new Planner.Rule("aaaaaaaa-1111-4111-8111-111111111111",
          "bbbbbbbb-2222-4222-8222-222222222222", zone, "2026-10-21", "2026-10-21",
          "2026-10-22T00:00:00Z", Set.of(), "08:00");
        System.out.println("accepted");
      } catch (TimezonePolicy.UnsupportedTimezone error) { System.out.println("rejected"); }
    }
  }
}
''')
    subprocess.run(["javac", "-d", str(build), str(source / "TimezonePolicy.java"),
                    str(source / "Planner.java"), str(probe)], check=True, capture_output=True, text=True)

    def validate(values):
        result = subprocess.run(["java", "-cp", str(build), "TimezoneProbe"],
                                input="".join(base64.b64encode(value.encode()).decode() + "\n" for value in values),
                                capture_output=True, text=True, check=True)
        return result.stdout.splitlines()
    return validate


def test_every_catalog_zone_is_accepted_by_both_profile_writes_and_native_snapshots(native_validator):
    zones = sorted(SUPPORTED_TIMEZONES)
    assert len(zones) == 484  # Expanding the published contract requires an explicit review.
    assert "UTC" in zones and "Asia/Jerusalem" in zones and "Etc/GMT+5" in zones
    assert native_validator(zones) == ["accepted"] * len(zones)
    for zone in zones:
        assert ProfileCreate(username="owner", display_name="Owner", timezone=zone).timezone == zone
        assert ProfileUpdate(timezone=zone).timezone == zone
        # Verify the pinned Python tzdata package, independently of host tzdb.
        with files("tzdata.zoneinfo").joinpath(zone).open("rb") as source:
            assert ZoneInfo.from_file(source, key=zone).key == zone


def test_runtime_specific_names_offsets_and_malformed_ids_are_rejected_consistently(native_validator):
    assert native_validator(REJECTED) == ["rejected"] * len(REJECTED)
    for zone in REJECTED:
        with pytest.raises(ValidationError):
            ProfileCreate(username="owner", display_name="Owner", timezone=zone)
        with pytest.raises(ValidationError):
            ProfileUpdate(timezone=zone)
