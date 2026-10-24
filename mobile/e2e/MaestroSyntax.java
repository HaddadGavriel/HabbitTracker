import java.nio.file.Path;
import maestro.orchestra.yaml.YamlCommandReader;

// Uses the same parser as the pinned Maestro 2.0.10 CLI; no device is required.
class MaestroSyntax {
    public static void main(String[] paths) {
        for (String path : paths) {
            var commands = YamlCommandReader.INSTANCE.readCommands(Path.of(path));
            System.out.println(path + ": parsed " + commands.size() + " commands");
        }
    }
}
