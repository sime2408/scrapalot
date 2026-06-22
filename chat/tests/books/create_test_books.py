"""
Create test PDF books with overlapping entities for cross-book RAG testing.

These books share concepts/entities with Art of War (Sun Tzu) to validate
that cross-book graph traversal finds related content across documents.
"""

import fitz  # PyMuPDF


def create_pdf(filename: str, title: str, chapters: list[dict]) -> str:
    """Create a PDF with chapters, each having a heading and body text."""
    doc = fitz.open()

    # Title page
    page = doc.new_page(width=595, height=842)  # A4
    page.insert_text(
        (72, 200),
        title,
        fontsize=28,
        fontname="helv",
    )
    page.insert_text(
        (72, 260),
        "Public Domain Text - For Testing Purposes",
        fontsize=12,
        fontname="helv",
    )

    for chapter in chapters:
        page = doc.new_page(width=595, height=842)
        y = 72

        # Chapter heading
        page.insert_text((72, y), chapter["heading"], fontsize=18, fontname="helv")
        y += 40

        # Body text - wrap at ~80 chars per line
        text = chapter["text"]
        lines = []
        for paragraph in text.split("\n\n"):
            words = paragraph.split()
            line = ""
            for word in words:
                if len(line) + len(word) + 1 > 80:
                    lines.append(line)
                    line = word
                else:
                    line = f"{line} {word}" if line else word
            if line:
                lines.append(line)
            lines.append("")  # Paragraph break

        for line in lines:
            if y > 780:
                page = doc.new_page(width=595, height=842)
                y = 72
            page.insert_text((72, y), line, fontsize=10, fontname="helv")
            y += 14

    doc.save(filename)
    doc.close()
    return filename


# Book 1: "The Art of Strategy" - shares military strategy concepts with Art of War
the_art_of_strategy_chapters = [
    {
        "heading": "Chapter 1: The Foundations of Strategy",
        "text": """Strategy is the art of creating power. Sun Tzu, the ancient Chinese military strategist,
understood that warfare is fundamentally about deception and the careful management of resources.
His teachings in The Art of War have influenced military commanders and business leaders for centuries.

The foundation of any strategy rests on understanding terrain, knowing the enemy, and recognizing
the strengths and weaknesses of one's own forces. A general who fails to assess these factors
before committing to battle is destined for defeat.

Strategic thinking requires patience and discipline. The great commanders throughout history
have demonstrated that victory often belongs not to the strongest army, but to the most
prepared and adaptable one. Alexander the Great conquered vast territories not through
brute force alone, but through superior strategic planning and rapid adaptation to circumstances.

The relationship between strategy and tactics must be clearly understood. Strategy determines
the overall direction and objectives of a campaign, while tactics are the specific methods
used to achieve those objectives on the battlefield. A brilliant tactician without strategic
vision will win battles but lose wars.""",
    },
    {
        "heading": "Chapter 2: Terrain and Positioning",
        "text": """Sun Tzu identified nine types of terrain in warfare, each requiring different
strategic approaches. The concept of terrain extends beyond physical geography to include
the competitive landscape, market conditions, and organizational dynamics.

Positioning is the art of placing one's forces in the most advantageous location before
engagement begins. In military terms, this means occupying high ground, controlling supply
lines, and ensuring lines of retreat. The general who controls terrain controls the battle.

Carl von Clausewitz, the Prussian military theorist, expanded on these concepts in his
treatise On War. He argued that war is an extension of politics by other means, and that
the fog of war makes perfect strategic planning impossible. The commander must be prepared
to adapt to rapidly changing circumstances.

Napoleon Bonaparte demonstrated mastery of terrain and positioning in his Italian campaigns.
By moving his forces with unprecedented speed across mountainous terrain, he repeatedly
caught his enemies off guard and achieved decisive victories despite being outnumbered.

The concept of strategic positioning applies equally to modern conflicts and business
competition. Companies that establish strong market positions before competitors can
build sustainable advantages that are difficult to overcome.""",
    },
    {
        "heading": "Chapter 3: Deception and Intelligence",
        "text": """All warfare is based on deception. This principle, articulated by Sun Tzu over two
thousand years ago, remains one of the most important concepts in military strategy. The
ability to mislead the enemy about one's true intentions, strength, and positioning can
determine the outcome of a campaign before the first arrow is fired.

Intelligence gathering is the foundation of effective deception. Without understanding
the enemy's disposition, capabilities, and intentions, a commander cannot craft effective
deceptive strategies. Sun Tzu emphasized the use of spies and agents to gather information,
categorizing them into five types: local spies, inward spies, converted spies, doomed spies,
and surviving spies.

The art of deception extends to the management of information within one's own forces.
A general must sometimes withhold information from subordinates to prevent leaks that
could compromise operations. The element of surprise has won more battles than superior
numbers or better weapons.

In the modern era, deception operations have become increasingly sophisticated. Electronic
warfare, cyber operations, and information campaigns represent new dimensions of the
ancient art that Sun Tzu described. The principles remain the same, even as the methods evolve.""",
    },
    {
        "heading": "Chapter 4: Leadership and Command",
        "text": """The quality of leadership determines the fate of armies and nations. Sun Tzu described
the ideal commander as one who possesses wisdom, sincerity, benevolence, courage, and
strictness. These five virtues, when combined, create a leader capable of inspiring
loyalty and achieving victory.

A great commander must understand the morale of troops and know when to advance and when
to retreat. The ability to read the psychological state of both friendly and enemy forces
is perhaps the most important skill a military leader can possess.

Throughout history, the most successful military leaders have shared certain characteristics.
They possess strategic vision that allows them to see beyond immediate circumstances. They
demonstrate personal courage that inspires their soldiers. And they maintain the discipline
necessary to execute complex plans under pressure.

Alexander the Great, Julius Caesar, and Napoleon all demonstrated these qualities in different
ways. Each adapted the timeless principles of warfare to the specific conditions of their era.
Sun Tzu's teachings provided a framework that transcends time and culture, offering guidance
that remains relevant in any competitive environment.""",
    },
    {
        "heading": "Chapter 5: The Economics of Warfare",
        "text": """Sun Tzu recognized that war is fundamentally an economic activity. The cost of maintaining
armies in the field, supplying weapons and provisions, and replacing losses places enormous
strain on a nation's resources. A prolonged war, no matter how successful militarily, can
bankrupt a state and leave it vulnerable to other threats.

The principle of economy of force requires a commander to achieve maximum results with minimum
expenditure of resources. This means avoiding unnecessary engagements, using terrain and
positioning to multiply the effectiveness of one's forces, and exploiting the enemy's
weaknesses rather than attacking their strengths.

Logistics is the foundation of military operations. An army that cannot feed its soldiers,
supply ammunition, and evacuate wounded cannot fight effectively regardless of how brilliant
its strategy or how brave its warriors. The greatest military disasters in history often
resulted from logistical failures rather than tactical defeats.

Modern warfare has made the economic dimension even more important. The development,
production, and maintenance of advanced weapons systems requires vast industrial capacity.
Nations that cannot sustain their military-industrial complex will eventually be unable
to compete with those that can.""",
    },
]

# Book 2: "Meditations on Leadership" - shares leadership/philosophy concepts
meditations_on_leadership_chapters = [
    {
        "heading": "Chapter 1: The Philosophy of Command",
        "text": """Marcus Aurelius, the Roman Emperor and Stoic philosopher, wrote in his Meditations
that the art of living is more like wrestling than dancing. This metaphor applies equally
to the art of leadership in both military and civilian contexts.

The ancient philosophers understood that true leadership begins with self-mastery. Before
one can command others effectively, one must first learn to command oneself. This principle
echoes Sun Tzu's emphasis on self-knowledge as a prerequisite for strategic success.

Stoic philosophy teaches that we cannot control external events, only our responses to them.
For a military commander facing the chaos of battle, this perspective is invaluable. The
leader who maintains composure under fire inspires confidence in subordinates and makes
better decisions under pressure.

The concept of virtue as the foundation of leadership transcends cultural boundaries.
Whether expressed in the Confucian tradition that influenced Sun Tzu, the Stoic philosophy
of Marcus Aurelius, or the Renaissance humanism of Machiavelli, the idea that ethical
character determines leadership effectiveness appears across civilizations.""",
    },
    {
        "heading": "Chapter 2: Decision Making Under Uncertainty",
        "text": """The fog of war, as described by Clausewitz, creates conditions of extreme uncertainty
that test the decision-making capacity of every commander. In these moments, the quality
of one's judgment determines the fate of armies and nations.

Effective decision making under uncertainty requires a combination of analytical thinking
and intuitive judgment. The experienced commander develops a sense for the flow of battle
that cannot be reduced to formal rules or algorithms. This intuition is built through
years of study, training, and experience.

Sun Tzu advocated extensive preparation and intelligence gathering as the primary means
of reducing uncertainty. The commander who has thoroughly studied the terrain, assessed
the enemy's capabilities, and prepared contingency plans for various scenarios will make
better decisions when the unexpected occurs.

The concept of calculated risk is central to military leadership. A commander who never
takes risks will never achieve decisive results. But reckless risk-taking leads to
catastrophic defeats. The art lies in judging which risks are worth taking and which
must be avoided. Napoleon's career illustrates both the rewards of bold action and
the consequences of overreach.""",
    },
    {
        "heading": "Chapter 3: Building and Sustaining Organizations",
        "text": """An army is more than a collection of soldiers with weapons. It is a complex organization
that requires careful management of human resources, logistics, training, and morale. The
greatest commanders in history were not just brilliant tacticians but also skilled
organizational leaders.

Sun Tzu devoted significant attention to the organizational aspects of warfare. His
discussions of troop management, the chain of command, and the importance of clear
communication reflect a sophisticated understanding of organizational dynamics.

The Roman legions represent perhaps the most successful military organization in history.
Their success was built not on individual heroism but on systematic training, standardized
equipment, clear command structures, and disciplined execution. Every legionary knew his
role and could perform it under the most adverse conditions.

Modern military organizations face challenges that Sun Tzu could not have imagined.
Technology has transformed the battlefield, requiring new organizational structures and
leadership approaches. Yet the fundamental principles of clear communication, unified
command, and disciplined execution remain as relevant today as they were in ancient China.""",
    },
    {
        "heading": "Chapter 4: The Ethics of Conflict",
        "text": """War raises profound ethical questions that military leaders must confront. Sun Tzu
himself recognized that the highest form of victory is to subdue the enemy without
fighting. This principle reflects a moral awareness that the use of force should always
be a last resort, employed only when all other options have been exhausted.

The concept of just war, developed in Western philosophy by thinkers from Augustine to
Aquinas, provides a framework for evaluating the morality of armed conflict. According
to this tradition, war is justified only when waged for a just cause, by legitimate
authority, as a last resort, and with reasonable hope of success.

The treatment of prisoners, civilians, and defeated enemies has been a measure of
civilized warfare since ancient times. Sun Tzu advised treating captured soldiers well,
recognizing that cruelty breeds resistance while magnanimity can convert enemies into
allies. This principle anticipated modern international humanitarian law by millennia.

In modern warfare, ethical considerations have become increasingly complex. The development
of weapons of mass destruction, the rise of asymmetric warfare, and the blurring of
distinctions between combatants and civilians create moral dilemmas that ancient strategists
never faced. Yet the fundamental ethical principles articulated by Sun Tzu and other
ancient thinkers remain essential guides for contemporary military leaders.""",
    },
]

# Book 3: "Principles of Naval Warfare" - shares warfare concepts in naval context
naval_warfare_chapters = [
    {
        "heading": "Chapter 1: Sea Power and National Strategy",
        "text": """Alfred Thayer Mahan, the American naval strategist, argued that control of the seas
is the key to national power and prosperity. His work The Influence of Sea Power upon
History transformed naval thinking and influenced the strategic policies of major nations
throughout the twentieth century.

The principles of naval strategy share many common elements with land warfare strategy.
Sun Tzu's emphasis on terrain, positioning, and the concentration of force applies equally
to operations at sea. The ocean is the ultimate terrain, offering both vast spaces for
maneuver and narrow chokepoints where decisive battles can be fought.

Naval power provides nations with the ability to project force across vast distances,
protect trade routes, and deny the enemy access to critical resources. Throughout history,
the rise and fall of great powers has been closely linked to their ability to build and
maintain powerful navies.

The Battle of Trafalgar in 1805 demonstrated how superior strategy and seamanship could
overcome numerical disadvantage. Admiral Nelson's decisive victory over the combined
French and Spanish fleets secured British naval supremacy for over a century and
fundamentally shaped the course of world history.""",
    },
    {
        "heading": "Chapter 2: Naval Tactics and Fleet Operations",
        "text": """The tactics of naval warfare have evolved dramatically over the centuries, from
the galley battles of the ancient Mediterranean to the carrier task forces of modern
navies. Yet certain fundamental principles remain constant across these transformations.

The concept of concentration of force, emphasized by both Sun Tzu and Clausewitz, is
particularly important in naval warfare. A fleet that disperses its strength across
too many objectives risks defeat in detail. The principle of bringing overwhelming force
to bear at the decisive point applies as much at sea as it does on land.

The element of surprise has played a crucial role in many naval victories. The Japanese
attack on Pearl Harbor in 1941, while strategically misguided, demonstrated the
devastating effectiveness of surprise in naval warfare. The ability to locate the enemy
while remaining undetected is the naval equivalent of Sun Tzu's principle that all
warfare is based on deception.

Modern naval tactics incorporate sophisticated technologies including radar, sonar,
satellite surveillance, and precision guided munitions. These technologies have
extended the range and lethality of naval forces but have not changed the fundamental
principles of naval tactics: seek the enemy, concentrate your forces, and strike
at the decisive moment.""",
    },
    {
        "heading": "Chapter 3: Submarine Warfare and Stealth",
        "text": """The submarine represents the ultimate expression of Sun Tzu's principle that the
supreme art of war is to subdue the enemy without fighting. The mere presence of
submarines in hostile waters forces the enemy to divert enormous resources to
anti-submarine warfare, reducing the forces available for offensive operations.

Submarine warfare introduces a dimension of stealth that has no parallel in land
warfare. Operating beneath the surface, submarines can approach enemy positions
undetected, gather intelligence, and strike without warning. This capability makes
them among the most powerful weapons in any navy's arsenal.

The development of nuclear-powered submarines in the 1950s revolutionized naval
warfare by eliminating the need for submarines to surface regularly. Nuclear submarines
can remain submerged for months, patrolling vast areas of ocean and providing a
continuous deterrent capability.

The strategic implications of submarine warfare extend far beyond tactical considerations.
Nuclear submarines carrying ballistic missiles form the most survivable component of
nuclear deterrence. Their ability to remain hidden in the depths of the ocean ensures
that no first strike could eliminate a nation's ability to retaliate, thus maintaining
the balance of terror that has prevented nuclear war.""",
    },
    {
        "heading": "Chapter 4: Amphibious Operations",
        "text": """Amphibious operations, the projection of military force from sea to land, represent
one of the most complex and challenging forms of warfare. They require the coordination
of naval, ground, and air forces in an environment that offers unique tactical challenges.

The ancient Athenian expedition against Syracuse, described by Thucydides, demonstrates
both the potential and the risks of amphibious operations. Despite initial success, the
Athenian force was eventually destroyed, contributing to Athens' defeat in the Peloponnesian
War. This historical lesson reinforces Sun Tzu's warning about the dangers of extended
campaigns far from home territory.

The Allied landings at Normandy on June 6, 1944, represent the most successful amphibious
operation in history. Operation Overlord succeeded through meticulous planning, overwhelming
force, effective deception operations, and the courage of the soldiers who stormed the beaches.
The deception component, Operation Fortitude, followed Sun Tzu's principles perfectly by
convincing the enemy that the main attack would come at a different location.

Modern amphibious doctrine emphasizes operational maneuver from the sea, using helicopters
and hovercraft to project forces rapidly inland rather than conducting the frontal assaults
of World War II. This approach reflects the timeless principle of avoiding the enemy's
strength and attacking where they are weak.""",
    },
]


if __name__ == "__main__":
    import sys

    output_dir = sys.argv[1] if len(sys.argv) > 1 else "."

    create_pdf(
        f"{output_dir}/the_art_of_strategy.pdf",
        "The Art of Strategy: Lessons from Ancient to Modern Warfare",
        the_art_of_strategy_chapters,
    )
    print(f"Created: {output_dir}/the_art_of_strategy.pdf")

    create_pdf(
        f"{output_dir}/meditations_on_leadership.pdf",
        "Meditations on Leadership: Philosophy and Command",
        meditations_on_leadership_chapters,
    )
    print(f"Created: {output_dir}/meditations_on_leadership.pdf")

    create_pdf(
        f"{output_dir}/principles_of_naval_warfare.pdf",
        "Principles of Naval Warfare: Strategy at Sea",
        naval_warfare_chapters,
    )
    print(f"Created: {output_dir}/principles_of_naval_warfare.pdf")
