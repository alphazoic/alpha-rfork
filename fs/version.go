package fs

// Version of rclone containing the complete version string
var Version string

// ProgramName identifies the executable distribution in CLI output.
var ProgramName = "rclone"

func init() {
	if Version == "" {
		if VersionSuffix == "" {
			Version = VersionTag
		} else {
			Version = VersionTag + "-" + VersionSuffix
		}
	}
}
